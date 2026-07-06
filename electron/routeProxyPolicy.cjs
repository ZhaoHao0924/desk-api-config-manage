const defaultRouteProxyFailureThreshold = 1;
const minRouteProxyFailureThreshold = 1;
const maxRouteProxyFailureThreshold = 10;
const defaultRouteProxyCooldownMs = 30_000;
const minRouteProxyCooldownMs = 5_000;
const maxRouteProxyCooldownMs = 600_000;

function normalizeIntegerRange(value, defaultValue, minValue, maxValue, fieldName) {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }

  const normalizedValue = Math.trunc(value);

  if (normalizedValue < minValue || normalizedValue > maxValue) {
    throw new Error(`${fieldName} must be between ${minValue} and ${maxValue}.`);
  }

  return normalizedValue;
}

function normalizeRouteProxyFailureThreshold(value) {
  return normalizeIntegerRange(
    value,
    defaultRouteProxyFailureThreshold,
    minRouteProxyFailureThreshold,
    maxRouteProxyFailureThreshold,
    "Route proxy failure threshold"
  );
}

function normalizeRouteProxyCooldownMs(value) {
  return normalizeIntegerRange(
    value,
    defaultRouteProxyCooldownMs,
    minRouteProxyCooldownMs,
    maxRouteProxyCooldownMs,
    "Route proxy cooldownMs"
  );
}

function shouldRetryRouteProxyResponse(statusCode) {
  return Number.isFinite(statusCode) && statusCode >= 500;
}

module.exports = {
  defaultRouteProxyCooldownMs,
  defaultRouteProxyFailureThreshold,
  maxRouteProxyCooldownMs,
  maxRouteProxyFailureThreshold,
  minRouteProxyCooldownMs,
  minRouteProxyFailureThreshold,
  normalizeRouteProxyCooldownMs,
  normalizeRouteProxyFailureThreshold,
  shouldRetryRouteProxyResponse
};
