import { ToolUsageError } from './tool-errors.js';
import { readResponseBytes, ResponseSizeLimitError } from './response-body.js';
const RESPONSE_LIMIT = 1024 * 1024;
const SOURCE = 'https://open-meteo.com/';
const CURRENT_FIELDS = ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day', 'precipitation', 'weather_code', 'wind_speed_10m'] as const;
const DAILY_FIELDS = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max'] as const;

export const weatherDefinitions = [
  {
    type: 'function', name: 'weather_forecast',
    description: 'Get model-based current conditions and forecast using coordinates or a place name. The location form uses the top geocoding match and lists other candidates; retry with coordinates or a more specific name (such as its English name or with country_code) if the match is wrong. Values are forecasts, not measured observations; weather_code is a WMO code, and null means unavailable. days defaults to 3.',
    parameters: {
      type: 'object', properties: {
        location: { type: 'string', minLength: 1 }, country_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
        latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
        days: { type: 'integer', minimum: 1, maximum: 7, default: 3 },
      }, required: [], additionalProperties: false,
    },
  },
] as const;

export type WeatherToolRuntime = {
  definitions: typeof weatherDefinitions;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
};

export function createWeatherToolRuntime(config: { fetcher?: typeof fetch } = {}): WeatherToolRuntime {
  const fetcher = config.fetcher ?? fetch;
  return {
    definitions: weatherDefinitions,
    async execute(name, args) {
      if (name !== 'weather_forecast') throw new ToolUsageError('Unknown weather tool');
      const allowed = ['location', 'country_code', 'latitude', 'longitude', 'days'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new ToolUsageError('Unknown weather tool argument');
      const locationForm = args.location !== undefined;
      if (!locationForm && args.country_code !== undefined) throw new ToolUsageError('country_code requires location');
      const coordinateForm = args.latitude !== undefined || args.longitude !== undefined;
      if (locationForm === coordinateForm || (locationForm && (args.latitude !== undefined || args.longitude !== undefined)) || (!locationForm && (args.latitude === undefined || args.longitude === undefined))) throw new ToolUsageError('Provide either location (optionally country_code) or both latitude and longitude');
      const days = args.days ?? 3;
      if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 7) throw new ToolUsageError('days must be an integer from 1 to 7');
      let chosenLocation: Record<string, unknown> | undefined;
      let otherCandidates: Record<string, unknown>[] = [];
      if (locationForm) {
        const location = text(args.location, 'location');
        const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
        url.search = new URLSearchParams({ name: location, count: '5', language: 'zh' }).toString();
        if (args.country_code !== undefined) {
          if (typeof args.country_code !== 'string' || !/^[A-Za-z]{2}$/.test(args.country_code)) throw new ToolUsageError('country_code must be a two-letter country code');
          url.searchParams.set('countryCode', args.country_code.toUpperCase());
        }
        const body = await request(url, fetcher);
        if (body.results !== undefined && (!Array.isArray(body.results) || body.results.length > 5)) invalidResponse();
        const results = ((body.results ?? []) as unknown[]).map(item => {
          const candidate = record(item);
          const optionalText = (field: string) => candidate[field] === undefined ? null : responseText(candidate[field]);
          return {
            name: responseText(candidate.name), country: optionalText('country'), admin1: optionalText('admin1'),
            latitude: coordinate(candidate.latitude, 'latitude', -90, 90), longitude: coordinate(candidate.longitude, 'longitude', -180, 180),
            timezone: optionalText('timezone'),
          };
        });
        if (!results.length) throw new ToolUsageError(`No location matched "${location}"; try the English place name or add country_code.`);
        chosenLocation = results[0]!;
        otherCandidates = results.slice(1);
        args = { ...args, latitude: chosenLocation.latitude, longitude: chosenLocation.longitude };
      }
      let latitude: number;
      let longitude: number;
      try { latitude = coordinate(args.latitude, 'latitude', -90, 90); longitude = coordinate(args.longitude, 'longitude', -180, 180); }
      catch (error) { throw new ToolUsageError(error instanceof Error ? error.message : String(error)); }
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), forecast_days: String(days), timezone: 'auto', current: CURRENT_FIELDS.join(','), daily: DAILY_FIELDS.join(',') }).toString();
      const body = await request(url, fetcher);
      const current = record(body.current);
      const daily = record(body.daily);
      const currentUnits = record(body.current_units);
      const dailyUnits = record(body.daily_units);
      const time = responseText(current.time);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(time) || !Number.isFinite(Date.parse(time))) invalidResponse();
      if (typeof current.interval !== 'number' || !Number.isSafeInteger(current.interval) || current.interval <= 0) invalidResponse();
      if (!Array.isArray(daily.time) || daily.time.length !== days) invalidResponse();
      const dates = daily.time.map(value => {
        const date = responseText(value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) invalidResponse();
        return date;
      });
      if (dates.some((date, index) => index > 0 && Date.parse(date) - Date.parse(dates[index - 1]!) !== 86_400_000)) invalidResponse();
      const currentOutput: Record<string, unknown> = { time, interval: current.interval };
      const dailyOutput: Record<string, unknown> = { time: dates };
      const currentUnitOutput: Record<string, string> = { time: responseUnit(currentUnits.time), interval: responseUnit(currentUnits.interval) };
      const dailyUnitOutput: Record<string, string> = { time: responseUnit(dailyUnits.time) };
      for (const field of CURRENT_FIELDS) {
        currentOutput[field] = weatherValue(current[field]);
        currentUnitOutput[field] = responseUnit(currentUnits[field]);
      }
      for (const field of DAILY_FIELDS) {
        const values = daily[field];
        if (!Array.isArray(values) || values.length !== dates.length) invalidResponse();
        dailyOutput[field] = values.map(weatherValue);
        dailyUnitOutput[field] = responseUnit(dailyUnits[field]);
      }
      if (typeof body.utc_offset_seconds !== 'number' || !Number.isSafeInteger(body.utc_offset_seconds)) invalidResponse();
      return {
        source: SOURCE, data_kind: 'model-based forecast, not measured observations',
        ...(chosenLocation ? { location: chosenLocation, other_candidates: otherCandidates, geocoding_source: 'https://www.geonames.org/' } : {}),
        latitude: coordinate(body.latitude, 'latitude', -90, 90), longitude: coordinate(body.longitude, 'longitude', -180, 180),
        timezone: responseText(body.timezone), utc_offset_seconds: body.utc_offset_seconds,
        current: currentOutput, current_units: currentUnitOutput, daily: dailyOutput, daily_units: dailyUnitOutput,
      };
    },
  };
}

async function request(url: URL, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try { response = await fetcher(url, { method: 'GET', signal, redirect: 'error' }); }
  catch { throw new Error(`Open-Meteo: ${signal.aborted ? 'request timed out' : 'request failed'}`); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Open-Meteo: HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Open-Meteo: response exceeds 1 MiB limit');
  }
  if (!response.body) invalidResponse();
  let bytes: Buffer;
  try { bytes = await readResponseBytes(response, RESPONSE_LIMIT); }
  catch (error) {
    throw new Error(`Open-Meteo: ${signal.aborted ? 'request timed out' : error instanceof ResponseSizeLimitError ? 'response exceeds 1 MiB limit' : 'response read failed'}`);
  }
  let body: unknown;
  try { body = JSON.parse(bytes.toString('utf8')); }
  catch { invalidResponse(); }
  const result = record(body);
  if (result.error === true) throw new Error('Open-Meteo: API reported an error');
  return result;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolUsageError(`${name} must be a non-empty string`);
  return value.trim();
}

function coordinate(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ToolUsageError(`${name} must be a number from ${min} to ${max}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function responseText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalidResponse();
  return value;
}

function responseUnit(value: unknown): string {
  if (typeof value !== 'string') invalidResponse();
  return value;
}

function weatherValue(value: unknown): number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) invalidResponse();
  return value as number | null;
}

function invalidResponse(): never { throw new Error('Open-Meteo: invalid response'); }
