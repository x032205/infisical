import { Knex } from "knex";
import { validate as uuidValidate } from "uuid";

import { TDbClient } from "@app/db";
import { ProjectType, SecretsV2Schema, SecretType, TableName, TSecretsV2, TSecretsV2Update } from "@app/db/schemas";
import { TKeyStoreFactory } from "@app/keystore/keystore";
import { getConfig } from "@app/lib/config/env";
import { generateCacheKeyFromData } from "@app/lib/crypto/cache";
import { BadRequestError, DatabaseError, NotFoundError } from "@app/lib/errors";
import {
  buildFindFilter,
  ormify,
  selectAllTableCols,
  sqlNestRelationships,
  TFindFilter,
  TFindOpt
} from "@app/lib/knex";
import { BufferKeysToString, OrderByDirection } from "@app/lib/types";
import { SecretsOrderBy } from "@app/services/secret/secret-types";
import type { TFindSecretsByFolderIdsFilter } from "@app/services/secret-v2-bridge/secret-v2-bridge-types";

export const SecretDalCacheKeys = {
  get productKey() {
    const { INFISICAL_PLATFORM_VERSION } = getConfig();
    return `${ProjectType.SecretManager}:${INFISICAL_PLATFORM_VERSION || 0}`;
  },
  getSecretDalVersion: (projectId: string) => {
    return `${SecretDalCacheKeys.productKey}:${projectId}:${TableName.SecretV2}-dal-version`;
  },
  findByFolderIds: (
    projectId: string,
    version: number,
    { useCache, tx, ...cacheKey }: Parameters<TSecretV2BridgeDALFactory["findByFolderIds"]>[0]
  ) => {
    return `${SecretDalCacheKeys.productKey}:${projectId}:${
      TableName.SecretV2
    }-dal:v${version}:find-by-folder-ids:${generateCacheKeyFromData(cacheKey)}`;
  },
  findByFolderId: (
    projectId: string,
    version: number,
    { useCache, tx, ...cacheKey }: Parameters<TSecretV2BridgeDALFactory["findByFolderId"]>[0]
  ) => {
    return `${SecretDalCacheKeys.productKey}:${projectId}:${
      TableName.SecretV2
    }-dal:v${version}:find-by-folder-id:${generateCacheKeyFromData(cacheKey)}`;
  },
  find: (projectId: string, version: number, ...args: Parameters<TSecretV2BridgeDALFactory["find"]>) => {
    const [filter, opts] = args;
    delete opts?.tx;
    delete opts?.useCache;
    return `${SecretDalCacheKeys.productKey}:${projectId}:${
      TableName.SecretV2
    }-dal:v${version}:find:${generateCacheKeyFromData({
      filter,
      opts
    })}`;
  }
};

export type TSecretV2BridgeDALFactory = ReturnType<typeof secretV2BridgeDALFactory>;
interface TSecretV2DalArg {
  db: TDbClient;
  keyStore: TKeyStoreFactory;
}

const SECRET_DAL_TTL = 5 * 60;
const SECRET_DAL_VERSION_TTL = 15 * 60;
const MAX_SECRET_CACHE_BYTES = 25 * 1024 * 1024;
export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
  const secretOrm = ormify(db, TableName.SecretV2);

  const invalidateSecretCacheByProjectId = async (projectId: string) => {
    const secretDalVersionKey = SecretDalCacheKeys.getSecretDalVersion(projectId);
    await keyStore.incrementBy(secretDalVersionKey, 1);
    await keyStore.setExpiry(secretDalVersionKey, SECRET_DAL_VERSION_TTL);
  };

  const findOne = async (filter: Partial<TSecretsV2>, tx?: Knex) => {
    try {
      const docs = await (tx || db)(TableName.SecretV2)
        .where(filter)
        .leftJoin(
          TableName.SecretV2JnTag,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )
        .leftJoin(
          TableName.SecretRotationV2SecretMapping,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretRotationV2SecretMapping}.secretId`
        )
        .select(selectAllTableCols(TableName.SecretV2))
        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
        .select(db.ref("rotationId").withSchema(TableName.SecretRotationV2SecretMapping));
      const data = sqlNestRelationships({
        data: docs,
        key: "id",
        parentMapper: (el) => ({
          _id: el.id,
          ...SecretsV2Schema.parse(el),
          isRotatedSecret: Boolean(el.rotationId),
          rotationId: el.rotationId
        }),
        childrenMapper: [
          {
            key: "tagId",
            label: "tags" as const,
            mapper: ({ tagId: id, tagColor: color, tagSlug: slug }) => ({
              id,
              color,
              slug,
              name: slug
            })
          }
        ]
      });
      return data?.[0];
    } catch (error) {
      throw new DatabaseError({ error, name: `${TableName.SecretV2}: FindOne` });
    }
  };

  const find = async (
    filter: TFindFilter<TSecretsV2>,
    opts: TFindOpt<TSecretsV2> & { useCache?: { projectId: string } } = {}
  ) => {
    const { offset, limit, sort, tx, useCache } = opts;
    try {
      let secretDalVersion = 0;
      if (useCache) {
        const cachedSecretDalVersion = await keyStore.getItem(
          SecretDalCacheKeys.getSecretDalVersion(useCache.projectId)
        );
        secretDalVersion = Number(cachedSecretDalVersion || 0);
        const cacheKey = SecretDalCacheKeys.find(useCache.projectId, secretDalVersion, filter, opts);
        const cachedSecrets = await keyStore.getItem(cacheKey);
        if (cachedSecrets) {
          await keyStore.setExpiry(cacheKey, SECRET_DAL_TTL);

          const unsanitizedSecrets = JSON.parse(cachedSecrets) as BufferKeysToString<(typeof data)[number]>[];
          const sanitizedSecrets = unsanitizedSecrets.map((el) => {
            const encryptedValue = el.encryptedValue ? Buffer.from(el.encryptedValue, "base64") : null;
            const encryptedComment = el.encryptedComment ? Buffer.from(el.encryptedComment, "base64") : null;
            const createdAt = new Date(el.createdAt);
            const updatedAt = new Date(el.updatedAt);
            return { ...el, encryptedComment, encryptedValue, createdAt, updatedAt };
          });
          return sanitizedSecrets;
        }
      }

      const query = (tx || db)(TableName.SecretV2)
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        .where(buildFindFilter(filter))
        .leftJoin(
          TableName.SecretV2JnTag,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )
        .leftJoin(TableName.ResourceMetadata, `${TableName.SecretV2}.id`, `${TableName.ResourceMetadata}.secretId`)
        .leftJoin(
          TableName.SecretRotationV2SecretMapping,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretRotationV2SecretMapping}.secretId`
        )
        .select(
          db.ref("id").withSchema(TableName.ResourceMetadata).as("metadataId"),
          db.ref("key").withSchema(TableName.ResourceMetadata).as("metadataKey"),
          db.ref("value").withSchema(TableName.ResourceMetadata).as("metadataValue")
        )
        .select(selectAllTableCols(TableName.SecretV2))
        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
        .select(db.ref("rotationId").withSchema(TableName.SecretRotationV2SecretMapping));
      if (limit) void query.limit(limit);
      if (offset) void query.offset(offset);
      if (sort) {
        void query.orderBy(sort.map(([column, order, nulls]) => ({ column: column as string, order, nulls })));
      }

      const docs = await query;
      const data = sqlNestRelationships({
        data: docs,
        key: "id",
        parentMapper: (el) => ({
          _id: el.id,
          ...SecretsV2Schema.parse(el),
          rotationId: el.rotationId,
          isRotatedSecret: Boolean(el.rotationId)
        }),
        childrenMapper: [
          {
            key: "tagId",
            label: "tags" as const,
            mapper: ({ tagId: id, tagColor: color, tagSlug: slug }) => ({
              id,
              color,
              slug,
              name: slug
            })
          },
          {
            key: "metadataId",
            label: "secretMetadata" as const,
            mapper: ({ metadataKey, metadataValue, metadataId }) => ({
              id: metadataId,
              key: metadataKey,
              value: metadataValue
            })
          }
        ]
      });

      if (useCache) {
        const cachedSecrets = data.map((el) => {
          const encryptedValue = el.encryptedValue ? el.encryptedValue.toString("base64") : null;
          const encryptedComment = el.encryptedComment ? el.encryptedComment.toString("base64") : null;
          return { ...el, encryptedValue, encryptedComment };
        });
        const cache = JSON.stringify(cachedSecrets);
        if (Buffer.byteLength(cache, "utf8") < MAX_SECRET_CACHE_BYTES) {
          await keyStore.setItemWithExpiry(
            SecretDalCacheKeys.find(useCache.projectId, secretDalVersion, filter, opts),
            SECRET_DAL_TTL,
            cache
          );
        }
      }

      return data;
    } catch (error) {
      throw new DatabaseError({ error, name: `${TableName.SecretV2}: Find` });
    }
  };

  const update = async (filter: Partial<TSecretsV2>, data: Omit<TSecretsV2Update, "version">, tx?: Knex) => {
    try {
      const sec = await (tx || db)(TableName.SecretV2)
        .where(filter)
        .update(data)
        .increment("version", 1)
        .returning("*");
      return sec;
    } catch (error) {
      throw new DatabaseError({ error, name: "update secret" });
    }
  };

  const bulkUpdate = async (
    data: Array<{ filter: Partial<TSecretsV2>; data: TSecretsV2Update }>,

    tx?: Knex
  ) => {
    try {
      const secs = await Promise.all(
        data.map(async ({ filter, data: updateData }) => {
          const [doc] = await (tx || db)(TableName.SecretV2)
            .where(filter)
            .update(updateData)
            .increment("version", 1)
            .returning("*");
          if (!doc) throw new BadRequestError({ message: "Failed to update document" });
          return doc;
        })
      );
      return secs;
    } catch (error) {
      throw new DatabaseError({ error, name: "bulk update secret" });
    }
  };

  const bulkUpdateNoVersionIncrement = async (data: TSecretsV2[], tx?: Knex) => {
    try {
      const existingSecrets = await secretOrm.find(
        {
          $in: {
            id: data.map((el) => el.id)
          }
        },
        { tx }
      );

      if (existingSecrets.length !== data.length) {
        throw new NotFoundError({ message: "One or more secrets was not found" });
      }

      if (data.length === 0) return [];

      const updatedSecrets = await (tx || db)(TableName.SecretV2)
        .insert(data)
        .onConflict("id") // this will cause a conflict then merge the data
        .merge() // Merge the data with the existing data
        .returning("*");

      return updatedSecrets;
    } catch (error) {
      throw new DatabaseError({ error, name: "bulk update secret" });
    }
  };

  const deleteMany = async (
    data: Array<{ key: string; type: SecretType }>,
    folderId: string,
    userId: string,
    tx?: Knex
  ) => {
    try {
      const deletedSecrets = await (tx || db)(TableName.SecretV2)
        .where({ folderId })
        .where((bd) => {
          data.forEach((el) => {
            void bd.orWhere({
              key: el.key,
              type: el.type,
              ...(el.type === SecretType.Personal ? { userId } : {})
            });
            // if shared is getting deleted then personal ones also should be deleted
            if (el.type === SecretType.Shared) {
              void bd.orWhere({
                key: el.key,
                type: SecretType.Personal
              });
            }
          });
        })
        .delete()
        .returning("*");
      return deletedSecrets;
    } catch (error) {
      throw new DatabaseError({ error, name: "delete many secret" });
    }
  };

  const findByFolderId = async (dto: {
    folderId: string;
    userId?: string;
    tx?: Knex;
    projectId: string;
    useCache?: boolean;
  }) => {
    try {
      const { folderId, tx, projectId } = dto;
      let { userId } = dto;
      // check if not uui then userId id is null (corner case because service token's ID is not UUI in effort to keep backwards compatibility from mongo
      if (userId && !uuidValidate(userId)) {
        // eslint-disable-next-line
        userId = undefined;
      }

      const cachedSecretDalVersion = await keyStore.getItem(SecretDalCacheKeys.getSecretDalVersion(projectId));
      const secretDalVersion = Number(cachedSecretDalVersion || 0);

      if (dto.useCache) {
        const cacheKey = SecretDalCacheKeys.findByFolderId(projectId, secretDalVersion, dto);
        const cachedSecrets = await keyStore.getItem(cacheKey);
        if (cachedSecrets) {
          await keyStore.setExpiry(cacheKey, SECRET_DAL_TTL);

          const unsanitizedSecrets = JSON.parse(cachedSecrets) as BufferKeysToString<(typeof data)[number]>[];
          const sanitizedSecrets = unsanitizedSecrets.map((el) => {
            const encryptedValue = el.encryptedValue ? Buffer.from(el.encryptedValue, "base64") : null;
            const encryptedComment = el.encryptedComment ? Buffer.from(el.encryptedComment, "base64") : null;
            const createdAt = new Date(el.createdAt);
            const updatedAt = new Date(el.updatedAt);
            return { ...el, encryptedComment, encryptedValue, createdAt, updatedAt };
          });
          return sanitizedSecrets;
        }
      }

      const secs = await (tx || db.replicaNode())(TableName.SecretV2)
        .where({ folderId })
        .where((bd) => {
          void bd
            .whereNull(`${TableName.SecretV2}.userId`)
            .orWhere({ [`${TableName.SecretV2}.userId` as "userId"]: userId || null });
        })
        .leftJoin(
          TableName.SecretV2JnTag,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )
        .leftJoin(TableName.ResourceMetadata, `${TableName.SecretV2}.id`, `${TableName.ResourceMetadata}.secretId`)
        .select(selectAllTableCols(TableName.SecretV2))
        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
        .select(
          db.ref("id").withSchema(TableName.ResourceMetadata).as("metadataId"),
          db.ref("key").withSchema(TableName.ResourceMetadata).as("metadataKey"),
          db.ref("value").withSchema(TableName.ResourceMetadata).as("metadataValue")
        )
        .orderBy("id", "asc");

      const data = sqlNestRelationships({
        data: secs,
        key: "id",
        parentMapper: (el) => ({ _id: el.id, ...SecretsV2Schema.parse(el) }),
        childrenMapper: [
          {
            key: "tagId",
            label: "tags" as const,
            mapper: ({ tagId: id, tagColor: color, tagSlug: slug }) => ({
              id,
              color,
              slug,
              name: slug
            })
          },
          {
            key: "metadataId",
            label: "secretMetadata" as const,
            mapper: ({ metadataKey, metadataValue, metadataId }) => ({
              id: metadataId,
              key: metadataKey,
              value: metadataValue
            })
          }
        ]
      });
      if (dto.useCache) {
        const newCachedSecrets = data.map((el) => {
          const encryptedValue = el.encryptedValue ? el.encryptedValue.toString("base64") : null;
          const encryptedComment = el.encryptedComment ? el.encryptedComment.toString("base64") : null;
          return { ...el, encryptedValue, encryptedComment };
        });
        const cache = JSON.stringify(newCachedSecrets);

        if (Buffer.byteLength(cache, "utf8") < MAX_SECRET_CACHE_BYTES) {
          await keyStore.setItemWithExpiry(
            SecretDalCacheKeys.findByFolderId(projectId, secretDalVersion, dto),
            SECRET_DAL_TTL,
            cache
          );
        }
      }
      return data;
    } catch (error) {
      throw new DatabaseError({ error, name: "get all secret" });
    }
  };

  const getSecretTags = async (secretId: string, tx?: Knex) => {
    try {
      const tags = await (tx || db.replicaNode())(TableName.SecretV2JnTag)
        .join(TableName.SecretTag, `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`, `${TableName.SecretTag}.id`)
        .where({ [`${TableName.SecretV2}Id` as const]: secretId })
        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"));

      return tags.map((el) => ({
        id: el.tagId,
        color: el.tagColor,
        slug: el.tagSlug,
        name: el.tagSlug
      }));
    } catch (error) {
      throw new DatabaseError({ error, name: "get secret tags" });
    }
  };

  // get unique secret count by folder IDs
  const countByFolderIds = async (
    folderIds: string[],
    userId?: string,
    tx?: Knex,
    filters?: {
      search?: string;
      tagSlugs?: string[];
    }
  ) => {
    try {
      // check if not uui then userId id is null (corner case because service token's ID is not UUI in effort to keep backwards compatibility from mongo)
      if (userId && !uuidValidate(userId)) {
        // eslint-disable-next-line no-param-reassign
        userId = undefined;
      }

      const query = (tx || db.replicaNode())(TableName.SecretV2)
        .leftJoin(
          TableName.SecretRotationV2SecretMapping,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretRotationV2SecretMapping}.secretId`
        )
        .whereIn("folderId", folderIds)
        .where((bd) => {
          if (filters?.search) {
            void bd.whereILike("key", `%${filters?.search}%`);
          }
        })
        .where((bd) => {
          void bd.whereNull("userId").orWhere({ userId: userId || null });
        })
        .countDistinct("key");

      // only need to join tags if filtering by tag slugs
      const slugs = filters?.tagSlugs?.filter(Boolean);
      if (slugs && slugs.length > 0) {
        void query
          .leftJoin(
            TableName.SecretV2JnTag,
            `${TableName.SecretV2}.id`,
            `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
          )
          .leftJoin(
            TableName.SecretTag,
            `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
            `${TableName.SecretTag}.id`
          )
          .whereIn("slug", slugs);
      }

      const secrets = await query;

      return Number(secrets[0]?.count ?? 0);
    } catch (error) {
      throw new DatabaseError({ error, name: "get folder secret count" });
    }
  };

  const findByFolderIds = async (dto: {
    folderIds: string[];
    userId?: string;
    tx?: Knex;
    projectId: string;
    filters?: TFindSecretsByFolderIdsFilter;
    useCache?: boolean;
  }) => {
    const { folderIds, tx, filters, useCache, projectId } = dto;
    let { userId } = dto;
    try {
      // check if not uui then userId id is null (corner case because service token's ID is not UUI in effort to keep backwards compatibility from mongo)
      if (userId && !uuidValidate(userId)) {
        // eslint-disable-next-line no-param-reassign
        userId = undefined;
      }

      const cachedSecretDalVersion = await keyStore.getItem(SecretDalCacheKeys.getSecretDalVersion(projectId));
      const secretDalVersion = Number(cachedSecretDalVersion || 0);
      if (useCache) {
        const cacheKey = SecretDalCacheKeys.findByFolderIds(projectId, secretDalVersion, dto);
        const cachedSecrets = await keyStore.getItem(cacheKey);
        if (cachedSecrets) {
          await keyStore.setExpiry(cacheKey, SECRET_DAL_TTL);

          const unsanitizedSecrets = JSON.parse(cachedSecrets) as BufferKeysToString<(typeof data)[number]>[];
          const sanitizedSecrets = unsanitizedSecrets.map((el) => {
            const encryptedValue = el.encryptedValue ? Buffer.from(el.encryptedValue, "base64") : null;
            const encryptedComment = el.encryptedComment ? Buffer.from(el.encryptedComment, "base64") : null;
            const createdAt = new Date(el.createdAt);
            const updatedAt = new Date(el.updatedAt);
            return { ...el, encryptedComment, encryptedValue, createdAt, updatedAt };
          });
          return sanitizedSecrets;
        }
      }

      const query = (tx || db.replicaNode())(TableName.SecretV2)
        .whereIn(`${TableName.SecretV2}.folderId`, folderIds)
        .where((bd) => {
          if (filters?.search) {
            if (filters?.includeTagsInSearch) {
              void bd
                .whereILike(`${TableName.SecretV2}.key`, `%${filters?.search}%`)
                .orWhereILike(`${TableName.SecretTag}.slug`, `%${filters?.search}%`);
            } else {
              void bd.whereILike(`${TableName.SecretV2}.key`, `%${filters?.search}%`);
            }
          }

          if (filters?.keys) {
            void bd.whereIn(`${TableName.SecretV2}.key`, filters.keys);
          }
        })
        .where((bd) => {
          void bd
            .whereNull(`${TableName.SecretV2}.userId`)
            .orWhere({ [`${TableName.SecretV2}.userId` as "userId"]: userId || null });
        })
        .leftJoin(
          TableName.SecretV2JnTag,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )
        .leftJoin(TableName.ResourceMetadata, `${TableName.SecretV2}.id`, `${TableName.ResourceMetadata}.secretId`)
        .leftJoin(
          TableName.SecretRotationV2SecretMapping,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretRotationV2SecretMapping}.secretId`
        )
        .where((qb) => {
          if (filters?.metadataFilter && filters.metadataFilter.length > 0) {
            filters.metadataFilter.forEach((meta) => {
              void qb.whereExists((subQuery) => {
                void subQuery
                  .select("secretId")
                  .from(TableName.ResourceMetadata)
                  .whereRaw(`"${TableName.ResourceMetadata}"."secretId" = "${TableName.SecretV2}"."id"`)
                  .where(`${TableName.ResourceMetadata}.key`, meta.key)
                  .where(`${TableName.ResourceMetadata}.value`, meta.value);
              });
            });
          }
        })
        .select(
          selectAllTableCols(TableName.SecretV2),
          db.raw(
            `DENSE_RANK() OVER (ORDER BY "${TableName.SecretV2}".key ${
              filters?.orderDirection ?? OrderByDirection.ASC
            }) as rank`
          )
        )
        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
        .select(
          db.ref("id").withSchema(TableName.ResourceMetadata).as("metadataId"),
          db.ref("key").withSchema(TableName.ResourceMetadata).as("metadataKey"),
          db.ref("value").withSchema(TableName.ResourceMetadata).as("metadataValue")
        )
        .select(db.ref("rotationId").withSchema(TableName.SecretRotationV2SecretMapping))
        .where((bd) => {
          const slugs = filters?.tagSlugs?.filter(Boolean);
          if (slugs && slugs.length > 0) {
            void bd.where((builder) => {
              // Either has the tag...
              void builder
                .whereIn(`${TableName.SecretTag}.slug`, slugs)
                // ...OR shares key & env with secrets that have the tag
                .orWhereIn([`${TableName.SecretV2}.key`, `${TableName.SecretV2}.folderId`], (subQuery) => {
                  void subQuery
                    .select([`${TableName.SecretV2}.key`, `${TableName.SecretV2}.folderId`])
                    .distinct()
                    .from(TableName.SecretV2)
                    .join(
                      TableName.SecretV2JnTag,
                      `${TableName.SecretV2}.id`,
                      `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
                    )
                    .join(
                      TableName.SecretTag,
                      `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
                      `${TableName.SecretTag}.id`
                    )
                    .whereIn(`${TableName.SecretTag}.slug`, slugs);
                });
            });
          }
        })
        .orderBy(
          filters?.orderBy === SecretsOrderBy.Name ? "key" : "id",
          filters?.orderDirection ?? OrderByDirection.ASC
        );

      let secs: Awaited<typeof query>;

      if (filters?.limit) {
        const rankOffset = (filters?.offset ?? 0) + 1; // ranks start at 1
        secs = await (tx || db)
          .with("w", query)
          .select("*")
          .from<Awaited<typeof query>[number]>("w")
          .where("w.rank", ">=", rankOffset)
          .andWhere("w.rank", "<", rankOffset + filters.limit);
      } else {
        secs = await query;
      }

      const data = sqlNestRelationships({
        data: secs,
        key: "id",
        parentMapper: (el) => ({
          _id: el.id,
          ...SecretsV2Schema.parse(el),
          rotationId: el.rotationId,
          isRotatedSecret: Boolean(el.rotationId)
        }),
        childrenMapper: [
          {
            key: "tagId",
            label: "tags" as const,
            mapper: ({ tagId: id, tagColor: color, tagSlug: slug }) => ({
              id,
              color,
              slug,
              name: slug
            })
          },
          {
            key: "metadataId",
            label: "secretMetadata" as const,
            mapper: ({ metadataKey, metadataValue, metadataId }) => ({
              id: metadataId,
              key: metadataKey,
              value: metadataValue
            })
          }
        ]
      });
      if (useCache) {
        const cachedSecrets = data.map((el) => {
          const encryptedValue = el.encryptedValue ? el.encryptedValue.toString("base64") : null;
          const encryptedComment = el.encryptedComment ? el.encryptedComment.toString("base64") : null;
          return { ...el, encryptedValue, encryptedComment };
        });
        const cache = JSON.stringify(cachedSecrets);

        if (Buffer.byteLength(cache, "utf8") < MAX_SECRET_CACHE_BYTES) {
          await keyStore.setItemWithExpiry(
            SecretDalCacheKeys.findByFolderIds(projectId, secretDalVersion, dto),
            SECRET_DAL_TTL,
            cache
          );
        }
      }

      return data;
    } catch (error) {
      throw new DatabaseError({ error, name: "get all secret" });
    }
  };

  const findBySecretKeys = async (
    folderId: string,
    query: Array<{ key: string; type: SecretType.Shared } | { key: string; type: SecretType.Personal; userId: string }>,
    tx?: Knex
  ) => {
    if (!query.length) return [];
    try {
      const secrets = await (tx || db.replicaNode())(TableName.SecretV2)
        .where({ folderId })

        .where((bd) => {
          query.forEach((el) => {
            if (el.type === SecretType.Personal && !el.userId) {
              throw new BadRequestError({ message: "Missing personal user id" });
            }
            void bd.orWhere({
              key: el.key,
              type: el.type,
              userId: el.type === SecretType.Personal ? el.userId : null
            });
          });
        })
        .leftJoin(
          TableName.SecretRotationV2SecretMapping,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretRotationV2SecretMapping}.secretId`
        )
        .select(selectAllTableCols(TableName.SecretV2))
        .select(db.ref("rotationId").withSchema(TableName.SecretRotationV2SecretMapping));
      return secrets.map((secret) => ({
        ...secret,
        isRotatedSecret: Boolean(secret.rotationId)
      }));
    } catch (error) {
      throw new DatabaseError({ error, name: "find by secret keys" });
    }
  };

  const upsertSecretReferences = async (
    data: {
      secretId: string;
      references: Array<{ environment: string; secretPath: string; secretKey: string }>;
    }[] = [],
    tx?: Knex
  ) => {
    try {
      if (!data.length) return;

      await (tx || db)(TableName.SecretReferenceV2)
        .whereIn(
          "secretId",
          data.map(({ secretId }) => secretId)
        )
        .delete();
      const newSecretReferences = data
        .filter(({ references }) => references.length)
        .flatMap(({ secretId, references }) =>
          references.map(({ environment, secretPath, secretKey }) => ({
            secretPath,
            secretId,
            environment,
            secretKey
          }))
        );
      if (!newSecretReferences.length) return;
      const secretReferences = await (tx || db).batchInsert(TableName.SecretReferenceV2, newSecretReferences);
      return secretReferences;
    } catch (error) {
      throw new DatabaseError({ error, name: "UpsertSecretReference" });
    }
  };

  const findReferencedSecretReferences = async (projectId: string, envSlug: string, secretPath: string, tx?: Knex) => {
    try {
      const docs = await (tx || db.replicaNode())(TableName.SecretReferenceV2)
        .where({
          secretPath,
          environment: envSlug
        })
        .join(TableName.SecretV2, `${TableName.SecretV2}.id`, `${TableName.SecretReferenceV2}.secretId`)
        .join(TableName.SecretFolder, `${TableName.SecretV2}.folderId`, `${TableName.SecretFolder}.id`)
        .join(TableName.Environment, `${TableName.SecretFolder}.envId`, `${TableName.Environment}.id`)
        .where("projectId", projectId)
        .select(selectAllTableCols(TableName.SecretReferenceV2))
        .select("folderId");

      return docs;
    } catch (error) {
      throw new DatabaseError({ error, name: "FindReferencedSecretReferences" });
    }
  };

  // special query to backfill secret value
  const findAllProjectSecretValues = async (projectId: string, tx?: Knex) => {
    try {
      const docs = await (tx || db.replicaNode())(TableName.SecretV2)
        .join(TableName.SecretFolder, `${TableName.SecretV2}.folderId`, `${TableName.SecretFolder}.id`)
        .join(TableName.Environment, `${TableName.SecretFolder}.envId`, `${TableName.Environment}.id`)
        .where("projectId", projectId)
        // not empty
        .whereNotNull("encryptedValue")
        .select("encryptedValue", `${TableName.SecretV2}.id` as "id");
      return docs;
    } catch (error) {
      throw new DatabaseError({ error, name: "FindAllProjectSecretValues" });
    }
  };

  const findOneWithTags = async (filter: Partial<TSecretsV2>, tx?: Knex) => {
    try {
      const rawDocs = await (tx || db.replicaNode())(TableName.SecretV2)
        .where(filter)
        .leftJoin(
          TableName.SecretV2JnTag,
          `${TableName.SecretV2}.id`,
          `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
        )
        .leftJoin(
          TableName.SecretTag,
          `${TableName.SecretV2JnTag}.${TableName.SecretTag}Id`,
          `${TableName.SecretTag}.id`
        )

        .leftJoin(TableName.SecretFolder, `${TableName.SecretV2}.folderId`, `${TableName.SecretFolder}.id`)
        .leftJoin(TableName.Environment, `${TableName.SecretFolder}.envId`, `${TableName.Environment}.id`)
        .leftJoin(TableName.ResourceMetadata, `${TableName.SecretV2}.id`, `${TableName.ResourceMetadata}.secretId`)
        .select(selectAllTableCols(TableName.SecretV2))
        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
        .select(
          db.ref("id").withSchema(TableName.ResourceMetadata).as("metadataId"),
          db.ref("key").withSchema(TableName.ResourceMetadata).as("metadataKey"),
          db.ref("value").withSchema(TableName.ResourceMetadata).as("metadataValue")
        )
        .select(db.ref("projectId").withSchema(TableName.Environment).as("projectId"));

      const docs = sqlNestRelationships({
        data: rawDocs,
        key: "id",
        parentMapper: (el) => ({ _id: el.id, projectId: el.projectId, ...SecretsV2Schema.parse(el) }),
        childrenMapper: [
          {
            key: "tagId",
            label: "tags" as const,
            mapper: ({ tagId: id, tagColor: color, tagSlug: slug }) => ({
              id,
              color,
              slug,
              name: slug
            })
          },
          {
            key: "metadataId",
            label: "secretMetadata" as const,
            mapper: ({ metadataKey, metadataValue, metadataId }) => ({
              id: metadataId,
              key: metadataKey,
              value: metadataValue
            })
          }
        ]
      });
      return docs?.[0];
    } catch (error) {
      throw new DatabaseError({ error, name: "FindOneWIthTags" });
    }
  };

  return {
    ...secretOrm,
    update,
    bulkUpdate,
    deleteMany,
    bulkUpdateNoVersionIncrement,
    getSecretTags,
    findOneWithTags,
    findByFolderId,
    findByFolderIds,
    findBySecretKeys,
    upsertSecretReferences,
    findReferencedSecretReferences,
    findAllProjectSecretValues,
    countByFolderIds,
    findOne,
    find,
    invalidateSecretCacheByProjectId
  };
};
