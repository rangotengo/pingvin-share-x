import * as moment from "moment";

export type Timespan = {
  value: number;
  unit: "minutes" | "hours" | "days" | "weeks" | "months" | "years";
};

export function stringToTimespan(value: string): Timespan {
  const [time, unit] = value.trim().split(/\s+/);
  return {
    value: parseInt(time),
    unit: unit as Timespan["unit"],
  };
}

export const VALID_TIMESPAN_UNITS = [
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
] as const;

export function isValidTimespanString(
  value: unknown,
  allowNegative = false,
): boolean {
  if (typeof value !== "string") return false;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return false;
  const num = Number(parts[0]);
  if (!Number.isInteger(num)) return false;
  if (!allowNegative && num < 0) return false;
  return (VALID_TIMESPAN_UNITS as readonly string[]).includes(parts[1]);
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; messageKey: string; fallbackMessage: string };

export function validateCandidateBatch(
  currentConfig: Map<string, string | number | boolean | null>,
  updates: { key: string; value: string | number | boolean | null }[],
): ValidationResult {
  // Build candidate state representing the world after applying all batch updates
  const candidate = new Map<string, string | number | boolean | null>(
    currentConfig,
  );
  for (const item of updates) {
    candidate.set(item.key, item.value === "" ? null : item.value);
  }

  // 1. Single-variable validations for updated items
  for (const item of updates) {
    const val = item.value === "" ? null : item.value;
    if (val === null) continue;

    if (item.key === "share.shareIdLength") {
      if (typeof val !== "number" || val < 2 || val > 50) {
        return {
          valid: false,
          messageKey: "config.shareIdLengthValidation",
          fallbackMessage: "Share ID length must be between 2 and 50",
        };
      }
    }

    if (item.key === "share.zipCompressionLevel") {
      if (typeof val !== "number" || val < 0 || val > 9) {
        return {
          valid: false,
          messageKey: "config.zipCompressionLevelValidation",
          fallbackMessage: "Zip compression level must be between 0 and 9",
        };
      }
    }

    if (item.key === "oauth.allowedHosts") {
      if (typeof val === "string" && val.length > 0) {
        const invalid = val.split(",").some((h) => {
          const trimmed = h.trim();
          return trimmed.includes("://") || trimmed.includes("/");
        });
        if (invalid) {
          return {
            valid: false,
            messageKey: "config.oauthAllowedHostsValidation",
            fallbackMessage:
              "Allowed hosts must be a comma-separated list of hostnames without protocol or paths",
          };
        }
      }
    }

    if (
      item.key === "share.maxExpiration" ||
      item.key === "share.defaultExpiration"
    ) {
      if (!isValidTimespanString(val, false)) {
        return {
          valid: false,
          messageKey: "config.timespanValidation",
          fallbackMessage:
            "Invalid timespan format. Must be '<number> <minutes|hours|days|weeks|months|years>'",
        };
      }
    }

    if (item.key === "share.fileRetentionPeriod") {
      if (!isValidTimespanString(val, true)) {
        return {
          valid: false,
          messageKey: "config.timespanValidation",
          fallbackMessage:
            "Invalid timespan format. Must be '<number> <minutes|hours|days|weeks|months|years>'",
        };
      }
    }
  }

  // 2. Cross-variable check: Google Drive vs S3
  const drive = candidate.get("googledrive.enabled");
  const s3 = candidate.get("s3.enabled");
  if ((drive === true || drive === "true") && (s3 === true || s3 === "true")) {
    return {
      valid: false,
      messageKey: "config.driveAndS3",
      fallbackMessage: "Enable only one of Google Drive or S3",
    };
  }

  // 3. Cross-variable check: defaultExpiration vs maxExpiration
  const maxExpVal = candidate.get("share.maxExpiration");
  const defExpVal = candidate.get("share.defaultExpiration");
  if (typeof maxExpVal === "string" && typeof defExpVal === "string") {
    if (
      isValidTimespanString(maxExpVal, false) &&
      isValidTimespanString(defExpVal, false)
    ) {
      const maxExp: Timespan = stringToTimespan(maxExpVal);
      const defExp: Timespan = stringToTimespan(defExpVal);

      // maxExp.value === 0 means unlimited / no maximum expiration
      if (maxExp.value > 0) {
        // If max is finite, default cannot be 0 (never)
        if (defExp.value === 0) {
          return {
            valid: false,
            messageKey: "config.defaultExpirationExceedsMax",
            fallbackMessage:
              "Default share expiration cannot exceed maximum expiration",
          };
        }

        const momentFn =
          (moment as unknown as { default?: typeof moment }).default || moment;
        const maxMs = momentFn
          .duration(maxExp.value, maxExp.unit)
          .asMilliseconds();
        const defMs = momentFn
          .duration(defExp.value, defExp.unit)
          .asMilliseconds();

        if (defMs > maxMs) {
          return {
            valid: false,
            messageKey: "config.defaultExpirationExceedsMax",
            fallbackMessage:
              "Default share expiration cannot exceed maximum expiration",
          };
        }
      }
    }
  }

  return { valid: true };
}
