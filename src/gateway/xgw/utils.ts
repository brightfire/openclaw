/**
 * Shared XGW utilities.
 */

/**
 * Resolve ${ENV_VAR} syntax to the actual environment variable value.
 */
export function resolveEnvValue(val: string): string {
  if (val.startsWith("${") && val.endsWith("}")) {
    const envVar = val.slice(2, -1);
    const envVal = process.env[envVar];
    if (envVal !== undefined && envVal !== "") {
      return envVal;
    }
    try {
      process.stderr.write(`[xgw] unresolved env var \${${envVar}}, using literal\n`);
    } catch {
      // swallow
    }
  }
  return val;
}
