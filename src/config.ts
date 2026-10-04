export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is missing. Copy .env.example to .env and set it.`);
  }
  return value;
}
