/**
 * AC-10 — device-side pseudo prefill. Per ADR-0002 this is deliberately a
 * localStorage-only convenience: there is no server-side device token, so
 * the remembered pseudo is a default for the field, never an identity claim,
 * and the field always stays editable.
 */

const STORAGE_KEY = 'pronos.pseudo';

export type PseudoField = { value: string; readOnly: boolean };

export function rememberPseudo(storage: Storage, pseudo: string): void {
  storage.setItem(STORAGE_KEY, pseudo);
}

export function loadRememberedPseudo(storage: Storage): string | null {
  return storage.getItem(STORAGE_KEY);
}

export function buildPseudoField(storage: Storage): PseudoField {
  return { value: loadRememberedPseudo(storage) ?? '', readOnly: false };
}
