import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolUsageError } from './tool-errors.js';

const exec = promisify(execFile);
// Explicitly reviewed observational actions. Upstream additions never gain access automatically.
const actions: Record<string, readonly string[]> = {
  github: ['search', 'read'], youtube: ['search', 'read', 'subtitle'],
  bilibili: ['search', 'read', 'hot', 'subtitle'], xiaohongshu: ['search', 'read', 'comments'],
  v2ex: ['hot', 'node', 'read', 'user'], reddit: ['search', 'read', 'subreddit'],
  twitter: ['search', 'profile', 'tweets', 'thread'], facebook: ['search', 'profile'],
  instagram: ['search', 'profile', 'posts'], linkedin: ['jobs', 'read'], boss: ['search', 'read'],
  xueqiu: ['quote', 'search', 'hot_posts', 'hot_stocks'], web: ['search', 'read'],
};
type Param = { name: string; required: boolean; type: string; help?: string; default?: unknown };
type Action = { name: string; help: string; params: Param[] };
type Channel = { name: string; description: string; level: string; actions: Action[] };
export const agentReachDefinition = {
  type: 'function', name: 'agent_reach', strict: false,
  description: 'Search/read social platforms and videos: Xiaohongshu, Bilibili, YouTube, V2EX, GitHub and more. Call action=capabilities first for supported platform actions and exact params. Read-only: no publishing, comments, likes, login/config changes or paid transcription. Platform support does not imply installed/logged-in/working. Loaded comments may be incomplete. Preserve returned link domains and required xsec_token; a domain does not establish account region.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', description: 'capabilities, or a platform action returned by capabilities.' },
    platform: { type: 'string', enum: Object.keys(actions), description: 'Required except for capabilities; optionally filter capabilities.' },
    params: { type: 'object', description: 'Named parameters from capabilities, e.g. {query:"AI",limit:5} or {target:"full note URL including xsec_token"}. No shell commands or extra flags.', additionalProperties: { type: ['string', 'integer'] } },
    timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Total deadline including capability lookup; default 60000.' },
  }, required: ['action'], additionalProperties: false },
};

// Channel declarations are static for an installed CLI; restart Butler after upgrading Agent Reach.
let declaredChannels: Channel[] | undefined;

export async function executeAgentReach(args: Record<string, unknown>, parentSignal?: AbortSignal): Promise<unknown> {
  if (Object.keys(args).some(key => !['action', 'platform', 'params', 'timeout_ms'].includes(key))) throw new ToolUsageError('Unknown agent_reach argument');
  const action = args.action, platform = args.platform;
  if (typeof action !== 'string' || (platform !== undefined && (typeof platform !== 'string' || !Object.hasOwn(actions, platform)))) throw new ToolUsageError('Invalid action or platform');
  if (action !== 'capabilities' && (typeof platform !== 'string' || !actions[platform]!.includes(action))) throw new ToolUsageError('Unsupported read-only action; call capabilities');
  const timeout = args.timeout_ms ?? 60000;
  if (!Number.isInteger(timeout) || Number(timeout) < 1000 || Number(timeout) > 120000) throw new ToolUsageError('timeout_ms must be 1000..120000');
  const params = args.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ToolUsageError('params must be an object');
  const values = params as Record<string, unknown>;
  if (action === 'capabilities' && Object.keys(values).length) throw new ToolUsageError('capabilities does not take params');
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(Number(timeout))]) : AbortSignal.timeout(Number(timeout));
  const started = Date.now();
  // Every CLI response is a JSON envelope whose `ok` decides success, whatever the exit status.
  const run = async (argv: string[]): Promise<any> => {
    signal.throwIfAborted();
    let stdout: string | undefined;
    try {
      // No shell interpolation; the signal alone enforces cancellation and the deadline.
      ({ stdout } = await exec('agent-reach', argv, { signal, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }));
    } catch (error) {
      if (signal.aborted) throw new Error('Agent Reach cancelled or deadline exceeded');
      stdout = (error as { stdout?: string }).stdout;
    }
    let result: any;
    try { result = JSON.parse(stdout ?? ''); } catch { /* reported below */ }
    if (result?.ok === true) return result;
    // Never include raw stderr/environment in errors; only the CLI's structured error.
    const error = result?.error;
    if (error?.code === 'BAD_INPUT') throw new ToolUsageError(`Agent Reach BAD_INPUT: ${String(error.message ?? '').slice(0, 500)}`);
    if (typeof error?.code === 'string') throw new Error(`Agent Reach ${error.code}: ${String(error.message ?? '').slice(0, 500)}`);
    throw new Error('Agent Reach failed (missing executable, invalid output, output limit or process failure); inspect local installation');
  };
  if (!declaredChannels) {
    const metadata = await run(['channels']);
    if (!Array.isArray(metadata.channels)) throw new Error('Agent Reach capability discovery failed');
    declaredChannels = metadata.channels as Channel[];
  }
  const channels = declaredChannels.filter(channel => Object.hasOwn(actions, channel.name) && (!platform || channel.name === platform)).map(channel => ({
    name: channel.name, description: channel.description, level: channel.level,
    actions: channel.actions.filter(item => actions[channel.name]!.includes(item.name)).map(item => ({ name: item.name, help: item.help, params: item.params })),
  }));
  if (action === 'capabilities') return { channels, read_only: true, availability: 'declared_not_live_tested', excluded: ['publishing', 'interaction writes', 'login/configuration', 'paid transcription'] };
  const spec = channels[0]?.actions.find(item => item.name === action);
  if (!spec) throw new ToolUsageError('Action unavailable in installed Agent Reach');
  if (Object.keys(values).some(key => !spec.params.some(param => param.name === key))) throw new ToolUsageError('Unknown platform parameter; call capabilities');
  const argv = [String(platform), action], positional: string[] = [];
  for (const param of spec.params) {
    const value = values[param.name];
    if (value === undefined) { if (param.required) throw new ToolUsageError(`Missing params.${param.name}`); continue; }
    if (param.type === 'int') {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 50) throw new ToolUsageError(`${param.name} must be an integer 1..50`);
    } else if (param.type !== 'str' || typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f]/.test(value)) {
      throw new ToolUsageError(`Invalid params.${param.name}`);
    }
    if (param.required) positional.push(String(value));
    // The attached form keeps a value starting with "-" from being parsed as a flag.
    else argv.push(`--${param.name}=${String(value)}`);
  }
  // End-of-options prevents positional text from becoming CLI flags.
  argv.push(`--timeout=${Math.max(1, Math.floor((Number(timeout) - (Date.now() - started)) / 1000))}`, '--', ...positional);
  return run(argv);
}
