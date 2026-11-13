import {
  type BotPlatformRuntimeContext,
  type BotProviderConfig,
  ClientFactory,
  type PlatformClient,
  type ValidationResult,
} from './types';

/** Catalog metadata stays eager; SDK code is imported only for an actual operation. */
export class LazyClientFactory extends ClientFactory {
  private loading?: Promise<ClientFactory>;

  constructor(private readonly load: () => Promise<ClientFactory>) {
    super();
  }

  private resolve(): Promise<ClientFactory> {
    if (!this.loading) {
      this.loading = Promise.resolve()
        .then(this.load)
        .catch((error: unknown) => {
          // A failed chunk load must not poison the factory for the process lifetime.
          this.loading = undefined;
          throw error;
        });
    }
    return this.loading;
  }

  async createClient(
    config: BotProviderConfig,
    context: BotPlatformRuntimeContext,
  ): Promise<PlatformClient> {
    return (await this.resolve()).createClient(config, context);
  }

  async validateCredentials(
    credentials: Record<string, string>,
    settings?: Record<string, unknown>,
    applicationId?: string,
    platform?: string,
  ): Promise<ValidationResult> {
    return (await this.resolve()).validateCredentials(
      credentials,
      settings,
      applicationId,
      platform,
    );
  }

  async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
    return (await this.resolve()).validateSettings(settings);
  }
}
