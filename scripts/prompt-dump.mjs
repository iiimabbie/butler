import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: node scripts/prompt-dump.mjs > prompt.md
// Compiles the current src (not the deployed dist) and prints the prompt prefix every ask starts with:
// workspace files, conversation conventions, tool index, skills catalog and every available tool definition.
// Session history, memory recall, opening/compact summaries and mid-ask runtime notices are not included.
// Tools follow .data/config.yaml; Google is treated as connected and the channel as a regular (non-notification) one.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'node_modules/.cache/prompt-dump');
rmSync(build, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--outDir', build], { cwd: root, encoding: 'utf8' });
if (tsc.status !== 0) { process.stderr.write(`${tsc.stdout}${tsc.stderr}`); process.exit(1); }
const load = name => import(pathToFileURL(path.join(build, name)).href);

const [{ promptPrefix }, { readConfig }, { createDiscordToolRuntime }, { googleDefinitions }, { LocalToolRuntime }, { createWebToolRuntime }, { createWeatherToolRuntime }, { createSkillsToolRuntime }, { scheduleToolDefinitions }, { createImageToolRuntime }, { createHledgerToolRuntime }, { residentToolNames }] = await Promise.all(
  ['agent.js', 'config.js', 'discord-tools.js', 'google-tools.js', 'local-tools.js', 'web-tools.js', 'weather-tools.js', 'skills.js', 'schedule-tools.js', 'image-tools.js', 'hledger-tools.js', 'tool-catalog.js'].map(load),
);
const settings = readConfig(path.join(root, '.data/config.yaml'));
const workspace = path.join(root, 'workspace');
const model = settings.llm?.model ?? '(unset)';
const localTools = new LocalToolRuntime();
const prefix = await promptPrefix({
  baseUrl: '', model, workspaceDirectory: workspace,
  hindsight: settings.memory ? {} : undefined,
  subagentCoordinator: {}, subagent: settings.subagent,
  discordTools: createDiscordToolRuntime({ token: '', context: {} }),
  googleTools: settings.google ? { definitions: googleDefinitions, available: async () => true } : undefined,
  localTools,
  webTools: createWebToolRuntime({ ...settings.web, reserveRequest: () => true }),
  weatherTools: createWeatherToolRuntime(),
  skillsTools: createSkillsToolRuntime(workspace),
  scheduleTools: { definitions: scheduleToolDefinitions },
  imageTools: settings.image ? createImageToolRuntime({ config: settings.image, attachmentDir: '', attachmentFiles: [] }) : undefined,
  hledgerTools: createHledgerToolRuntime({ enabled: settings.hledger?.enabled ?? false, journalPath: '', schedules: { load: () => [], save: () => {} } }),
});
await localTools.close?.();

const text = content => typeof content === 'string' ? content : JSON.stringify(content, null, 2);
const out = [`Butler prompt prefix · model: ${model} · generated ${new Date().toISOString()} from working-tree src\n`];
prefix.input.forEach((item, index) => out.push(`===== [${index + 1}] ${item.role} =====\n\n${text(item.content)}\n`));
out.push(`===== Tools (${prefix.tools.length}) =====\n\nEvery tool also takes a required \`label\` (progress label) argument, omitted below. [resident] tools are sent with every request; the rest load through tools_catalog.\n`);
for (const tool of prefix.tools) {
  const { label: _label, ...properties } = tool.parameters.properties ?? {};
  const parameters = { ...tool.parameters, properties, required: (tool.parameters.required ?? []).filter(name => name !== 'label') };
  out.push(`----- ${tool.name}${residentToolNames.has(tool.name) ? ' [resident]' : ''} -----\n\n${tool.description ?? ''}\n\n\`\`\`json\n${JSON.stringify(parameters, null, 2)}\n\`\`\`\n`);
}
process.stdout.write(out.join('\n'));
