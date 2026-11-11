// Secret redaction applied to every observation before it is hashed, stored
// or printed.
//
// Scope, stated honestly: this removes credentials that match known shapes and
// keys with credential-bearing names. It is not a proof that no secret can
// reach the output. The primary defence is upstream of here -- checks observe
// narrow, named facts and never capture whole environments, whole files or raw
// command lines. This is the second layer, not the only one.

const SECRET_PATTERNS = Object.freeze([
  // GitHub tokens: classic, OAuth, user-to-server, server-to-server, refresh.
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '<redacted:github-token>'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '<redacted:github-pat>'],
  // AWS access key id, and the secret that usually travels beside it.
  [/AKIA[0-9A-Z]{16}/g, '<redacted:aws-access-key-id>'],
  // PEM private keys, including the body.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted:private-key>'],
  // Authorization headers.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/g, '<redacted:bearer-token>'],
  // Credentials embedded in a URL: scheme://user:secret@host
  [/(?<=:\/\/)[^:@/\s]+:[^@/\s]+(?=@)/g, '<redacted:url-credentials>'],
]);

/** Key names whose value is replaced wholesale, whatever its shape. */
const CREDENTIAL_KEY = /^(authorization|cookie|set-cookie|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|api[-_]?key|private[-_]?key|credential|credentials)$/i;

/** Key names that carry a whole process environment. Never recorded. */
const ENVIRONMENT_KEY = /^(env|environ|environment|process[-_]?env)$/i;

export function redactString(text) {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Recursively redact a serializable value. Returns a new value; the input is
 * never mutated.
 */
export function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      output[key] = '<redacted:credential-key>';
      continue;
    }
    if (ENVIRONMENT_KEY.test(key)) {
      output[key] = '<redacted:environment>';
      continue;
    }
    output[key] = redact(nested);
  }
  return output;
}
