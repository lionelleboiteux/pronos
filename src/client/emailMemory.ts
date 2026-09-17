/**
 * Device-side email prefill, mirroring pseudoMemory.ts (AC-10) exactly: a
 * pure localStorage convenience with no server-side device token, so the
 * remembered email is a default for the field, never an identity claim, and
 * the field always stays editable and optional.
 */

const STORAGE_KEY = 'pronos.email';

export type EmailField = { value: string; readOnly: boolean };

export function rememberEmail(storage: Storage, email: string): void {
  storage.setItem(STORAGE_KEY, email);
}

export function loadRememberedEmail(storage: Storage): string | null {
  return storage.getItem(STORAGE_KEY);
}

export function buildEmailField(storage: Storage): EmailField {
  return { value: loadRememberedEmail(storage) ?? '', readOnly: false };
}
