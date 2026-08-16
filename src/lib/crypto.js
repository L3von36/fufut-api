async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Password hashing.
 *
 * Two formats exist and both must verify:
 *
 *   legacy   "<salt>:<sha256(password + salt)>"
 *   current  "pbkdf2$<iterations>$<salt>$<hex>"
 *
 * The legacy form is a single SHA-256 round with no key stretching, which a GPU
 * chews through at enormous rates. It cannot be rewritten in place because the
 * plaintext is not recoverable, so it stays readable and every hash upgrades
 * itself the next time its owner successfully signs in.
 *
 * PBKDF2 is used rather than bcrypt or Argon2 because it is what WebCrypto
 * offers inside a Worker, and it is a large improvement on a bare digest.
 */
/**
 * 100,000 is the platform ceiling, not a preference: Workers rejects anything
 * higher with "Pbkdf2 failed: iteration counts above 100000 are not supported".
 * Asking for more does not degrade, it throws, so this cannot be raised without
 * moving off WebCrypto entirely.
 *
 * The stored format carries its own iteration count, so if that ceiling ever
 * lifts, new hashes can use a higher number and existing ones keep verifying at
 * the count they were made with.
 */
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_PREFIX = "pbkdf2";

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSalt(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations,
      hash: "SHA-256",
    },
    key,
    256
  );
  return toHex(bits);
}

/** Hash a new password. Always produces the current format. */
async function hashPassword(password) {
  const salt = randomSalt();
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

/** True when `stored` is in the older, unstretched format. */
function isLegacyHash(storedHash) {
  return typeof storedHash === "string" && !storedHash.startsWith(`${PBKDF2_PREFIX}$`) && storedHash.includes(":");
}

/**
 * Constant-time-ish comparison. Not a full defence in a JS runtime, but it
 * removes the trivially exploitable early-exit of `===` on long strings.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;

  if (storedHash.startsWith(`${PBKDF2_PREFIX}$`)) {
    const [, iterationsRaw, salt, hash] = storedHash.split("$");
    const iterations = Number(iterationsRaw);
    if (!salt || !hash || !Number.isFinite(iterations) || iterations <= 0) return false;
    const computed = await pbkdf2(password, salt, iterations);
    return safeEqual(computed, hash);
  }

  if (!storedHash.includes(":")) return false;
  const [salt, hash] = storedHash.split(":");
  const computed = await sha256(password + salt);
  return safeEqual(computed, hash);
}

/**
 * A temporary password for a manager to hand over in person. Deliberately not
 * a fixed default: "reset to default" is how a whole team ends up sharing one
 * credential. Ambiguous characters are left out so it survives being read aloud
 * or written on a pad.
 */
function generateTempPassword(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Minimum bar for a password somebody chooses for themselves. */
function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (password.length > 200) return "Password is too long";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must contain at least one letter and one number";
  }
  return null;
}

export {
  sha256,
  verifyPassword,
  hashPassword,
  isLegacyHash,
  generateTempPassword,
  passwordProblem,
  PBKDF2_ITERATIONS,
};
