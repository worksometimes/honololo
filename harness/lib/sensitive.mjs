// Recognises the shapes a credential or a personal identifier takes in free text. This is a
// backstop under the operator's own judgement, never a substitute for it: it cannot read a sentence
// and decide whether the fact inside it should be written down. It exists so a memory that outlives
// every run cannot accumulate a secret through one careless note.
//
// Each pattern matches a value, not a topic word. "the auth token expires after an hour" is a fact
// worth remembering; "token: eyJhbGciOi…" is the thing that must never be written. Refusing the
// first would teach the operator to stop writing notes, which costs more than it protects.
const PATTERNS = [
  [/\b(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*\S{6,}/iu,
    'a labelled credential value'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/u, 'a bearer token'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./u, 'a JSON web token'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/u, 'an API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/u, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/u, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/u, 'an AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, 'a private key'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u, 'an email address'],
  [/\b[A-Fa-f0-9]{32,}\b/u, 'a long hex string'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/u, 'a long base64 string'],
];

export function rejectSensitive(text) {
  for (const [pattern, description] of PATTERNS) {
    if (pattern.test(text)) return description;
  }
  return null;
}
