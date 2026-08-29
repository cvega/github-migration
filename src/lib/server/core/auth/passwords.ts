const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_MAX_BYTES = 512;
const ARGON2_MEMORY_COST = 65_536;
const ARGON2_TIME_COST = 3;
const ARGON2_PREFIX = `$argon2id$v=19$m=${ARGON2_MEMORY_COST},t=${ARGON2_TIME_COST},p=1$`;
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$C2khMPrwYeRQh9sViHAhNi7PG6lwrdN8pPLgL6CeZ/g$0vQIBSyFz8pSWjcmY3RoTWUjLyHNNSr+53D0+9HD5mg";

export function passwordPolicyError(password: string): string | null {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (
    length > PASSWORD_MAX_LENGTH ||
    new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES
  ) {
    return `Password must be no more than ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash, "argon2id");
  } catch {
    return false;
  }
}

export async function verifyPasswordOrDummy(
  password: string,
  hash: string | null,
): Promise<boolean> {
  const matches = await verifyPassword(password, hash ?? DUMMY_PASSWORD_HASH);
  return hash !== null && matches;
}

export function passwordHashNeedsUpgrade(hash: string): boolean {
  return !hash.startsWith(ARGON2_PREFIX);
}

export function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
