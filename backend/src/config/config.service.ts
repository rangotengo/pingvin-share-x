import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Config } from "@prisma/client";
import * as argon from "argon2";
import { EventEmitter } from "events";
import * as fs from "fs";
import { PrismaService } from "src/prisma/prisma.service";
import { stringToTimespan } from "src/utils/date.util";
import { validateCandidateBatch } from "./config.protocol";
import { parse as yamlParse } from "yaml";
import { I18nContext } from "nestjs-i18n";
import { YamlConfig } from "../../prisma/seed/config.seed";
import { CONFIG_FILE } from "src/constants";

export const LEGACY_CONFIG_ALIASES: Record<
  string,
  { category: string; name: string }
> = {
  "security.sessionDuration": { category: "general", name: "sessionDuration" },
  "security.secureCookies": { category: "general", name: "secureCookies" },
  "security.enableEmailVerification": {
    category: "email",
    name: "enableEmailVerification",
  },
  "security.allowRegistration": {
    category: "share",
    name: "allowRegistration",
  },
  "security.allowUnauthenticatedShares": {
    category: "share",
    name: "allowUnauthenticatedShares",
  },
  "security.allowAdminAccessAllShares": {
    category: "share",
    name: "allowAdminAccessAllShares",
  },
  "share.enableShareEmailRecipients": {
    category: "email",
    name: "enableShareEmailRecipients",
  },
  "share.enableShareDownloadNotifications": {
    category: "email",
    name: "enableShareDownloadNotifications",
  },
};

/**
 * ConfigService extends EventEmitter to allow listening for config updates,
 * now only `update` event will be emitted.
 */
@Injectable()
export class ConfigService extends EventEmitter {
  yamlConfig?: YamlConfig;
  logger = new Logger(ConfigService.name);

  constructor(
    @Inject("CONFIG_VARIABLES") private configVariables: Config[],
    private prisma: PrismaService,
  ) {
    super();
  }

  // Initialize gets called by the ConfigModule
  async initialize() {
    await this.loadYamlConfig();

    if (this.yamlConfig) {
      await this.migrateInitUser();
    }
  }

  private async loadYamlConfig() {
    let configFile: string = "";
    try {
      configFile = fs.readFileSync(CONFIG_FILE, "utf8");
    } catch {
      this.logger.log(
        "Config.yaml is not set. Falling back to UI configuration.",
      );
    }
    try {
      this.yamlConfig = yamlParse(configFile);

      if (this.yamlConfig) {
        for (const configVariable of this.configVariables) {
          const currentKey = `${configVariable.category}.${configVariable.name}`;
          const category = this.yamlConfig[configVariable.category];
          let val = category?.[configVariable.name];

          if (val === undefined && LEGACY_CONFIG_ALIASES[currentKey]) {
            const legacy = LEGACY_CONFIG_ALIASES[currentKey];
            const legacyVal = this.yamlConfig[legacy.category]?.[legacy.name];
            if (legacyVal !== undefined) {
              val = legacyVal;
              this.logger.warn(
                this.t(
                  "config.deprecatedVariable",
                  "Config variable '{legacyKey}' is deprecated. Please move it to '{modernKey}' in your config.yaml",
                  {
                    legacyKey: `${legacy.category}.${legacy.name}`,
                    modernKey: `${configVariable.category}.${configVariable.name}`,
                  },
                ),
              );
            }
          }

          if (val !== undefined) {
            configVariable.value = val === null ? null : String(val);
            this.emit(
              "update",
              `${configVariable.category}.${configVariable.name}`,
              configVariable.value,
            );
          }
        }
      }
    } catch (e) {
      this.logger.error(
        "Failed to parse config.yaml. Falling back to UI configuration: ",
        e,
      );
    }
  }

  private async migrateInitUser(): Promise<void> {
    if (!this.yamlConfig.initUser?.enabled) return;

    const userCount = await this.prisma.user.count({
      where: { isAdmin: true },
    });
    if (userCount === 1) {
      this.logger.log(
        "Skip initial user creation. Admin user is already existent.",
      );
      return;
    }
    await this.prisma.user.create({
      data: {
        email: this.yamlConfig.initUser.email,
        username: this.yamlConfig.initUser.username,
        password: this.yamlConfig.initUser.password
          ? await argon.hash(this.yamlConfig.initUser.password)
          : null,
        isAdmin: this.yamlConfig.initUser.isAdmin,
      },
    });
  }

  get(key: `${string}.${string}`): any {
    const configVariable = this.configVariables.filter(
      (variable) => `${variable.category}.${variable.name}` == key,
    )[0];

    if (!configVariable) throw new Error(`Config variable ${key} not found`);

    const value = configVariable.value ?? configVariable.defaultValue;

    if (configVariable.type == "number" || configVariable.type == "filesize")
      return parseInt(value);
    if (configVariable.type == "boolean") return value == "true";
    if (configVariable.type == "string" || configVariable.type == "text")
      return value;
    if (configVariable.type == "timespan") return stringToTimespan(value);
  }

  async getByCategory(category: string) {
    const configVariables = this.configVariables
      .filter((c) => !c.locked && category == c.category)
      .sort((a, b) => a.order - b.order);

    return configVariables.map((variable) => {
      return {
        ...variable,
        key: `${variable.category}.${variable.name}`,
        value: variable.value ?? variable.defaultValue,
        allowEdit: this.isEditAllowed(),
      };
    });
  }

  async list() {
    const configVariables = this.configVariables.filter((c) => !c.secret);

    return configVariables.map((variable) => {
      return {
        ...variable,
        key: `${variable.category}.${variable.name}`,
        value: variable.value ?? variable.defaultValue,
      };
    });
  }

  async updateMany(data: { key: string; value: string | number | boolean }[]) {
    if (!this.isEditAllowed())
      throw new BadRequestException(
        this.t(
          "config.editNotAllowed",
          "You are only allowed to update config variables via the config.yaml file",
        ),
      );

    // Validate existence, lock status, and basic types
    for (const variable of data) {
      const [category, name] = variable.key.split(".");
      const configVariable = this.configVariables.find(
        (c) => c.category === category && c.name === name,
      );

      if (!configVariable || configVariable.locked) {
        throw new NotFoundException(
          this.t("config.variableNotFound", "Config variable not found"),
        );
      }

      if (
        variable.value !== "" &&
        variable.value !== null &&
        typeof variable.value !== configVariable.type &&
        typeof variable.value === "string" &&
        configVariable.type !== "text" &&
        configVariable.type !== "timespan"
      ) {
        throw new BadRequestException(
          this.t(
            "config.invalidType",
            "Config variable must be of type {type}",
            {
              type: configVariable.type,
            },
          ),
        );
      }
    }

    // Validate candidate batch state across variables
    const currentConfig = new Map<string, string | number | boolean | null>();
    for (const c of this.configVariables) {
      currentConfig.set(`${c.category}.${c.name}`, c.value ?? c.defaultValue);
    }
    const validationResult = validateCandidateBatch(currentConfig, data);
    if (validationResult.valid === false) {
      throw new BadRequestException(
        this.t(
          validationResult.messageKey,
          validationResult.fallbackMessage,
        ),
      );
    }

    // Atomically persist all updates
    const response: Config[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const variable of data) {
        const [category, name] = variable.key.split(".");
        const val =
          variable.value === "" || variable.value === null
            ? null
            : variable.value.toString();

        const updated = await tx.config.update({
          where: {
            name_category: {
              category,
              name,
            },
          },
          data: { value: val },
        });
        response.push(updated);
      }
    });

    this.configVariables = await this.prisma.config.findMany();
    for (const variable of data) {
      this.emit("update", variable.key, variable.value);
    }

    return response;
  }

  async update(key: string, value: string | number | boolean) {
    const response = await this.updateMany([{ key, value }]);
    return response[0];
  }

  async setInternal(key: `${string}.${string}`, value: string | null) {
    const [category, name] = key.split(".");
    await this.prisma.config.update({
      where: { name_category: { category, name } },
      data: { value },
    });
    const variable = this.configVariables.find(
      (item) => item.category === category && item.name === name,
    );
    if (variable) variable.value = value;
  }

  isEditAllowed(): boolean {
    return this.yamlConfig === undefined || this.yamlConfig === null;
  }

  private t(
    key: string,
    fallback: string,
    args?: Record<string, string | number | boolean>,
  ) {
    const translated = I18nContext.current()?.t(key, { args });
    if (translated && translated !== key) return translated;

    return Object.entries(args ?? {}).reduce(
      (message, [argKey, value]) =>
        message.replaceAll(`{${argKey}}`, String(value)),
      fallback,
    );
  }
}
