import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  AiModelSortMap,
  AiProviderModelListItem,
  EnabledAiModel,
  ToggleAiModelEnableParams,
} from 'model-bank';
import { AiModelSourceEnum } from 'model-bank';

import type { AiModelSelectItem, NewAiModelItem } from '../schemas';
import { aiModels, aiProviders } from '../schemas';
import type { LobeChatDatabase } from '../type';

export class AiModelModel {
  private userId: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string) {
    this.userId = userId;
    this.db = db;
  }

  /**
   * Helper method to validate if array is empty and return early if needed
   * @param array - Array to validate
   * @returns true if array is empty, false otherwise
   */
  private isEmptyArray(array: unknown[]): boolean {
    return array.length === 0;
  }

  create = async (params: NewAiModelItem) => {
    const [result] = await this.db
      .insert(aiModels)
      .values({
        ...params,
        enabled: params.enabled ?? true, // enabled by default, but respect explicit value
        source: AiModelSourceEnum.Custom,
        userId: this.userId,
      })
      .returning();

    return result;
  };

  delete = async (id: string, providerId: string) => {
    return this.db
      .delete(aiModels)
      .where(
        and(
          eq(aiModels.id, id),
          eq(aiModels.providerId, providerId),
          eq(aiModels.userId, this.userId),
        ),
      );
  };

  deleteAll = async () => {
    return this.db.delete(aiModels).where(eq(aiModels.userId, this.userId));
  };

  query = async () => {
    return this.db.query.aiModels.findMany({
      orderBy: [desc(aiModels.updatedAt)],
      where: eq(aiModels.userId, this.userId),
    });
  };

  getModelListByProviderId = async (providerId: string) => {
    const result = await this.db
      .select({
        abilities: aiModels.abilities,
        config: aiModels.config,
        contextWindowTokens: aiModels.contextWindowTokens,
        description: aiModels.description,
        displayName: aiModels.displayName,
        enabled: aiModels.enabled,
        id: aiModels.id,
        parameters: aiModels.parameters,
        pricing: aiModels.pricing,
        releasedAt: aiModels.releasedAt,
        settings: aiModels.settings,
        source: aiModels.source,
        type: aiModels.type,
      })
      .from(aiModels)
      .where(and(eq(aiModels.providerId, providerId), eq(aiModels.userId, this.userId)))
      .orderBy(
        asc(aiModels.sort),
        desc(aiModels.enabled),
        desc(aiModels.releasedAt),
        desc(aiModels.updatedAt),
      );

    return result as AiProviderModelListItem[];
  };

  getAllModels = async () => {
    const data = await this.db
      .select({
        abilities: aiModels.abilities,
        config: aiModels.config,
        contextWindowTokens: aiModels.contextWindowTokens,
        displayName: aiModels.displayName,
        enabled: aiModels.enabled,
        id: aiModels.id,
        parameters: aiModels.parameters,
        providerId: aiModels.providerId,
        releasedAt: aiModels.releasedAt,
        settings: aiModels.settings,
        sort: aiModels.sort,
        source: aiModels.source,
        type: aiModels.type,
      })
      .from(aiModels)
      .where(and(eq(aiModels.userId, this.userId)));

    return data as EnabledAiModel[];
  };

  findById = async (id: string) => {
    return this.db.query.aiModels.findFirst({
      where: and(eq(aiModels.id, id), eq(aiModels.userId, this.userId)),
    });
  };

  update = async (id: string, providerId: string, value: Partial<AiModelSelectItem>) => {
    return this.db
      .insert(aiModels)
      .values({ ...value, id, providerId, updatedAt: new Date(), userId: this.userId })
      .onConflictDoUpdate({
        set: value,
        target: [aiModels.id, aiModels.providerId, aiModels.userId],
      });
  };

  toggleModelEnabled = async (value: ToggleAiModelEnableParams) => {
    const now = new Date();
    const insertValues = {
      ...value,
      updatedAt: now,
      userId: this.userId,
    } as typeof aiModels.$inferInsert;

    if (value.type) insertValues.type = value.type;

    const updateValues: Partial<typeof aiModels.$inferInsert> = {
      enabled: value.enabled,
      updatedAt: now,
    };

    if (value.type) updateValues.type = value.type;

    return this.db
      .insert(aiModels)
      .values(insertValues)
      .onConflictDoUpdate({
        set: updateValues,
        target: [aiModels.id, aiModels.providerId, aiModels.userId],
      });
  };

  batchUpdateAiModels = async (providerId: string, models: AiProviderModelListItem[]) => {
    // Early return if models array is empty to prevent database insertion error
    if (this.isEmptyArray(models)) {
      return [];
    }

    const records = models.map(({ id, ...model }) => ({
      ...model,
      id,
      providerId,
      updatedAt: new Date(),
      userId: this.userId,
    }));

    return this.db
      .insert(aiModels)
      .values(records)
      .onConflictDoNothing({
        target: [aiModels.id, aiModels.userId, aiModels.providerId],
      })
      .returning();
  };

  /** Replace only this account's provider catalog, preserving surviving user preferences atomically. */
  replaceRemoteModels = async (providerId: string, models: AiProviderModelListItem[]) => {
    // An empty/failed upstream response must not erase a working catalog.
    if (this.isEmptyArray(models)) return [];
    if (
      models.some(
        (model) => !model.id?.trim() || model.id !== model.id.trim() || model.id.length > 150,
      )
    )
      throw new Error('Invalid remote model ID');
    const unique = [...new Map(models.map((model) => [model.id, model])).values()];

    return this.db.transaction(async (tx) => {
      const scope = and(eq(aiProviders.id, providerId), eq(aiProviders.userId, this.userId));
      const [provider] = await tx
        .select({ settings: aiProviders.settings })
        .from(aiProviders)
        .where(scope);
      if (!provider) throw new Error('Provider must be configured before synchronizing its models');
      const existing = await tx
        .select()
        .from(aiModels)
        .where(and(eq(aiModels.providerId, providerId), eq(aiModels.userId, this.userId)));
      const previous = new Map(existing.map((model) => [model.id, model]));
      const records = unique.map((model) => ({
        ...model,
        ...previous.get(model.id),
        id: model.id,
        providerId,
        source: AiModelSourceEnum.Remote,
        updatedAt: new Date(),
        userId: this.userId,
      }));

      await tx
        .delete(aiModels)
        .where(and(eq(aiModels.providerId, providerId), eq(aiModels.userId, this.userId)));
      const result = await tx.insert(aiModels).values(records).returning();
      await tx
        .update(aiProviders)
        .set({
          settings: { ...provider.settings, modelListSource: 'remote' },
          updatedAt: new Date(),
        })
        .where(scope);
      return result;
    });
  };

  batchToggleAiModels = async (providerId: string, models: string[], enabled: boolean) => {
    // Early return if models array is empty to prevent database insertion error
    if (this.isEmptyArray(models)) {
      return;
    }

    // Get default model list to preserve type information
    const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');
    const defaultModelMap = new Map(LOBE_DEFAULT_MODEL_LIST.map((m) => [m.id, m]));

    // Prepare all records for batch upsert
    const allRecords = models.map((modelId) => {
      const defaultModel = defaultModelMap.get(modelId);
      const record: typeof aiModels.$inferInsert = {
        enabled,
        id: modelId,
        providerId,
        // if the model is not in the db, it's a builtin model
        source: AiModelSourceEnum.Builtin,
        updatedAt: new Date(),
        userId: this.userId,
      };

      // Preserve type if available from default model list
      if (defaultModel?.type) {
        record.type = defaultModel.type;
      }

      return record;
    });

    // Use batch upsert to handle both insert and update in a single query
    return this.db
      .insert(aiModels)
      .values(allRecords)
      .onConflictDoUpdate({
        set: {
          enabled: sql`excluded.enabled`,
          updatedAt: sql`excluded.updated_at`,
        },
        target: [aiModels.id, aiModels.userId, aiModels.providerId],
      });
  };

  clearRemoteModels(providerId: string) {
    return this.db
      .delete(aiModels)
      .where(
        and(
          eq(aiModels.providerId, providerId),
          eq(aiModels.source, AiModelSourceEnum.Remote),
          eq(aiModels.userId, this.userId),
        ),
      );
  }

  clearModelsByProvider(providerId: string) {
    return this.db
      .delete(aiModels)
      .where(and(eq(aiModels.providerId, providerId), eq(aiModels.userId, this.userId)));
  }

  updateModelsOrder = async (providerId: string, sortMap: AiModelSortMap[]) => {
    // Early return if sortMap array is empty
    if (this.isEmptyArray(sortMap)) {
      return;
    }

    await this.db.transaction(async (tx) => {
      const updates = sortMap.map(({ id, sort, type }) => {
        const now = new Date();
        const insertValues: typeof aiModels.$inferInsert = {
          enabled: true,
          id,
          providerId,
          sort,
          // source: isBuiltin ? 'builtin' : 'custom',
          updatedAt: now,
          userId: this.userId,
        };

        if (type) insertValues.type = type;

        const updateValues: Partial<typeof aiModels.$inferInsert> = {
          sort,
          updatedAt: now,
        };

        if (type) updateValues.type = type;

        return tx
          .insert(aiModels)
          .values(insertValues)
          .onConflictDoUpdate({
            set: updateValues,
            target: [aiModels.id, aiModels.userId, aiModels.providerId],
          });
      });

      await Promise.all(updates);
    });
  };
}
