import JavaScriptObfuscator from 'javascript-obfuscator';
import { createHash } from 'crypto';

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

function seedRandom(seed, salt) {
  const hash = createHash('sha256').update(seed + ':' + salt).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

function pickFromSeed(seed, salt, choices) {
  const idx = Math.floor(seedRandom(seed, salt) * choices.length);
  return choices[Math.min(idx, choices.length - 1)];
}

const seed = process.env.OBF_SEED || createHash('sha256').update(String(Date.now())).digest('hex');
const sourceType = process.env.OBF_SOURCE_TYPE === 'module' ? 'module' : 'script';

const rand = (salt) => seedRandom(seed, salt);

const encoding = pickFromSeed(seed, 'encoding', ['base64', 'rc4']);
const identifierGen = pickFromSeed(seed, 'identifiers', ['hexadecimal', 'mangled-shuffled']);
const splitChunkLen = 5 + Math.floor(rand('chunkLen') * 11);
const cffThreshold = 0.5 + rand('cff') * 0.25;
const dciThreshold = 0.3 + rand('dci') * 0.2;
const saThreshold = 0.5 + rand('saThreshold') * 0.25;
const saCallsThreshold = 0.5 + rand('saCalls') * 0.25;
const wrappersCount = 1 + Math.floor(rand('wrappers') * 2);
const wrappersMaxParams = 2 + Math.floor(rand('wrapParams') * 3);

const options = {
  seed: seed,
  target: 'browser-no-eval',
  sourceType: sourceType,

  compact: true,
  simplify: true,
  numbersToExpressions: true,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,

  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: cffThreshold,

  deadCodeInjection: true,
  deadCodeInjectionThreshold: dciThreshold,

  // disabled: incompatible with MV3 extension CSP / service workers
  debugProtection: false,
  debugProtectionInterval: 0,
  selfDefending: false,
  disableConsoleOutput: false,

  identifierNamesGenerator: identifierGen,
  renameGlobals: false,
  renameProperties: false,
  reservedNames: ['^chrome$', '^browser$', '^self$', '^globalThis$', '^importScripts$', '^caches$', '^clients$', '^registration$'],

  splitStrings: true,
  splitStringsChunkLength: splitChunkLen,

  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: saCallsThreshold,
  stringArrayEncoding: [encoding],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: wrappersCount,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: wrappersMaxParams,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: saThreshold,
};

try {
  const input = await readStdin();
  if (input.trim().length < 10) {
    process.stdout.write(input);
    process.exit(0);
  }
  const result = JavaScriptObfuscator.obfuscate(input, options);
  process.stdout.write(result.getObfuscatedCode());
} catch (err) {
  process.stderr.write('obfuscation error: ' + err.message + '\n');
  process.exit(1);
}
