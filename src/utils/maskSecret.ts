export function maskSecret(value: string): string {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return "";
  }

  if (normalizedValue.length <= 12) {
    return "****";
  }

  return `${normalizedValue.slice(0, 7)}...${normalizedValue.slice(-4)}`;
}

