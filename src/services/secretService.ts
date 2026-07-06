export interface SecretCopyOptions {
  clearAfterMs?: number;
}

export interface SecretCopyResult {
  clearAfterMs: number;
}

export interface SecretService {
  isEncryptionAvailable(): Promise<boolean>;
  encryptSecret(plaintext: string): Promise<string>;
  decryptSecret(encryptedValue: string): Promise<string>;
  copySecretToClipboard(plaintext: string, options?: SecretCopyOptions): Promise<SecretCopyResult>;
}

export function createDesktopSecretService(
  deskApi: Window["deskApi"] | undefined = typeof window === "undefined" ? undefined : window.deskApi
): SecretService | undefined {
  if (!deskApi?.secrets) {
    return undefined;
  }

  return {
    isEncryptionAvailable: () => deskApi.secrets.isEncryptionAvailable(),
    encryptSecret: (plaintext: string) => deskApi.secrets.encrypt(plaintext),
    decryptSecret: (encryptedValue: string) => deskApi.secrets.decrypt(encryptedValue),
    copySecretToClipboard: (plaintext: string, options?: SecretCopyOptions) =>
      deskApi.secrets.copyToClipboard(plaintext, options)
  };
}
