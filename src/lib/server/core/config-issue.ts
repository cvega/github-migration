/**
 * Operator-facing configuration problems. An issue names an environment
 * variable and a fixed rule from this module; it never carries the configured
 * value, so it is safe for capability reports, setup pages and logs.
 */
const RULES = {
  required: "is required",
  "absolute-path": "must be an absolute path",
  "pem-private-key": "must be PEM or base64-encoded PEM",
  port: "must be an integer between 1 and 65535",
  "positive-integer": "must be a positive integer",
  "valid-url": "must be a valid URL",
  "exporter-runtime": "is invalid",
  "docker-size": "must be a positive Docker size such as 512m or 2g",
  cpus: "must be a number between 0.1 and 64",
  "pids-limit": "must be an integer between 16 and 4096",
  "docker-network": "must be a Docker network name other than 'host'",
} as const;

export type ConfigRule = keyof typeof RULES;

export interface ConfigIssue {
  /** Environment variable name, or null when the failure is not attributable. */
  variable: string | null;
  text: string;
}

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
const UNATTRIBUTED_ISSUE: ConfigIssue = { variable: null, text: "Configuration is invalid" };

export class ConfigIssueError extends TypeError {
  readonly issue: ConfigIssue;

  constructor(variable: string, rule: ConfigRule) {
    if (!VARIABLE_NAME.test(variable)) {
      throw new TypeError("A configuration issue requires an environment variable name");
    }
    const text = `${variable} ${RULES[rule]}`;
    super(text);
    this.name = "ConfigIssueError";
    this.issue = { variable, text };
  }
}

/** Run independent checks and keep one safe issue for each that fails. */
export function collectConfigIssues(checks: ReadonlyArray<() => unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const check of checks) {
    try {
      check();
    } catch (error) {
      // Other errors may quote configured values (for example malformed URLs).
      issues.push(error instanceof ConfigIssueError ? error.issue : UNATTRIBUTED_ISSUE);
    }
  }
  return issues;
}
