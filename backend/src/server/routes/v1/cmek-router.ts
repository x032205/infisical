import { z } from "zod";

import { InternalKmsSchema, KmsKeysSchema } from "@app/db/schemas";
import { EventType } from "@app/ee/services/audit-log/audit-log-types";
import { KMS } from "@app/lib/api-docs";
import { getBase64SizeInBytes, isBase64 } from "@app/lib/base64";
import { AllowedEncryptionKeyAlgorithms, SymmetricKeyEncryptDecrypt } from "@app/lib/crypto/cipher";
import { AsymmetricKeySignVerify, SigningAlgorithm } from "@app/lib/crypto/sign";
import { OrderByDirection } from "@app/lib/types";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { slugSchema } from "@app/server/lib/schemas";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { AuthMode } from "@app/services/auth/auth-type";
import { CmekOrderBy, TCmekKeyEncryptionAlgorithm } from "@app/services/cmek/cmek-types";
import { KmsKeyIntent } from "@app/services/kms/kms-types";

const keyNameSchema = slugSchema({ min: 1, max: 32, field: "Name" });
const keyDescriptionSchema = z.string().trim().max(500).optional();

const CmekSchema = KmsKeysSchema.merge(
  InternalKmsSchema.pick({ version: true, encryptionAlgorithm: true, type: true })
).omit({
  isReserved: true
});

const base64Schema = z.string().superRefine((val, ctx) => {
  if (!isBase64(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "plaintext must be base64 encoded"
    });
  }

  if (getBase64SizeInBytes(val) > 4096) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "data cannot exceed 4096 bytes"
    });
  }
});

export const registerCmekRouter = async (server: FastifyZodProvider) => {
  // create encryption key
  server.route({
    method: "POST",
    url: "/keys",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Create KMS key",
      body: z
        .object({
          projectId: z.string().describe(KMS.CREATE_KEY.projectId),
          name: keyNameSchema.describe(KMS.CREATE_KEY.name),
          description: keyDescriptionSchema.describe(KMS.CREATE_KEY.description),
          type: z
            .nativeEnum(KmsKeyIntent)
            .optional()
            .default(KmsKeyIntent.ENCRYPT_DECRYPT)
            .describe(KMS.CREATE_KEY.type),
          encryptionAlgorithm: z
            .enum(AllowedEncryptionKeyAlgorithms)
            .optional()
            .default(SymmetricKeyEncryptDecrypt.AES_GCM_256)
            .describe(KMS.CREATE_KEY.encryptionAlgorithm)
        })
        .superRefine((data, ctx) => {
          if (
            data.type === KmsKeyIntent.ENCRYPT_DECRYPT &&
            !Object.values(SymmetricKeyEncryptDecrypt).includes(data.encryptionAlgorithm as SymmetricKeyEncryptDecrypt)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `encryptionAlgorithm must be a valid symmetric encryption algorithm. Valid options are: ${Object.values(
                SymmetricKeyEncryptDecrypt
              ).join(", ")}`
            });
          }
          if (
            data.type === KmsKeyIntent.SIGN_VERIFY &&
            !Object.values(AsymmetricKeySignVerify).includes(data.encryptionAlgorithm as AsymmetricKeySignVerify)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `encryptionAlgorithm must be a valid asymmetric sign-verify algorithm. Valid options are: ${Object.values(
                AsymmetricKeySignVerify
              ).join(", ")}`
            });
          }
        }),
      response: {
        200: z.object({
          key: CmekSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        body: { projectId, name, description, encryptionAlgorithm, type },
        permission
      } = req;

      const cmek = await server.services.cmek.createCmek(
        {
          orgId: permission.orgId,
          projectId,
          name,
          description,
          encryptionAlgorithm: encryptionAlgorithm as TCmekKeyEncryptionAlgorithm,
          type
        },
        permission
      );

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        projectId,
        event: {
          type: EventType.CREATE_CMEK,
          metadata: {
            keyId: cmek.id,
            name,
            description,
            encryptionAlgorithm: encryptionAlgorithm as TCmekKeyEncryptionAlgorithm
          }
        }
      });

      return { key: cmek };
    }
  });

  // update KMS key
  server.route({
    method: "PATCH",
    url: "/keys/:keyId",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Update KMS key",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.UPDATE_KEY.keyId)
      }),
      body: z.object({
        name: keyNameSchema.optional().describe(KMS.UPDATE_KEY.name),
        isDisabled: z.boolean().optional().describe(KMS.UPDATE_KEY.isDisabled),
        description: keyDescriptionSchema.describe(KMS.UPDATE_KEY.description)
      }),
      response: {
        200: z.object({
          key: CmekSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        body,
        permission
      } = req;

      const cmek = await server.services.cmek.updateCmekById({ keyId, ...body }, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: permission.orgId,
        event: {
          type: EventType.UPDATE_CMEK,
          metadata: {
            keyId,
            ...body
          }
        }
      });

      return { key: cmek };
    }
  });

  // delete KMS key
  server.route({
    method: "DELETE",
    url: "/keys/:keyId",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Delete KMS key",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.DELETE_KEY.keyId)
      }),
      response: {
        200: z.object({
          key: CmekSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        permission
      } = req;

      const cmek = await server.services.cmek.deleteCmekById(keyId, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: permission.orgId,
        event: {
          type: EventType.DELETE_CMEK,
          metadata: {
            keyId
          }
        }
      });

      return { key: cmek };
    }
  });

  // list KMS keys
  server.route({
    method: "GET",
    url: "/keys",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "List KMS keys",
      querystring: z.object({
        projectId: z.string().describe(KMS.LIST_KEYS.projectId),
        offset: z.coerce.number().min(0).optional().default(0).describe(KMS.LIST_KEYS.offset),
        limit: z.coerce.number().min(1).max(100).optional().default(100).describe(KMS.LIST_KEYS.limit),
        orderBy: z.nativeEnum(CmekOrderBy).optional().default(CmekOrderBy.Name).describe(KMS.LIST_KEYS.orderBy),
        orderDirection: z
          .nativeEnum(OrderByDirection)
          .optional()
          .default(OrderByDirection.ASC)
          .describe(KMS.LIST_KEYS.orderDirection),
        search: z.string().trim().optional().describe(KMS.LIST_KEYS.search)
      }),
      response: {
        200: z.object({
          keys: CmekSchema.array(),
          totalCount: z.number()
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        query: { projectId, ...dto },
        permission
      } = req;

      const { cmeks, totalCount } = await server.services.cmek.listCmeksByProjectId({ projectId, ...dto }, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        projectId,
        event: {
          type: EventType.GET_CMEKS,
          metadata: {
            keyIds: cmeks.map((key) => key.id)
          }
        }
      });

      return { keys: cmeks, totalCount };
    }
  });

  server.route({
    method: "GET",
    url: "/keys/:keyId",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "Get KMS key by ID",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.GET_KEY_BY_ID.keyId)
      }),
      response: {
        200: z.object({
          key: CmekSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        permission
      } = req;

      const key = await server.services.cmek.findCmekById(keyId, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        projectId: key.projectId!,
        event: {
          type: EventType.GET_CMEK,
          metadata: {
            keyId: key.id
          }
        }
      });

      return { key };
    }
  });

  server.route({
    method: "GET",
    url: "/keys/key-name/:keyName",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "Get KMS key by Name",
      params: z.object({
        keyName: slugSchema({ field: "Key name" }).describe(KMS.GET_KEY_BY_NAME.keyName)
      }),
      querystring: z.object({
        projectId: z.string().min(1, "Project ID is required").describe(KMS.GET_KEY_BY_NAME.projectId)
      }),
      response: {
        200: z.object({
          key: CmekSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyName },
        query: { projectId },
        permission
      } = req;

      const key = await server.services.cmek.findCmekByName(keyName, projectId, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        projectId: key.projectId!,
        event: {
          type: EventType.GET_CMEK,
          metadata: {
            keyId: key.id
          }
        }
      });

      return { key };
    }
  });

  // encrypt data
  server.route({
    method: "POST",
    url: "/keys/:keyId/encrypt",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Encrypt data with KMS key",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.ENCRYPT.keyId)
      }),
      body: z.object({
        plaintext: base64Schema.describe(KMS.ENCRYPT.plaintext)
      }),
      response: {
        200: z.object({
          ciphertext: z.string()
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        body: { plaintext },
        permission
      } = req;

      const ciphertext = await server.services.cmek.cmekEncrypt({ keyId, plaintext }, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: permission.orgId,
        event: {
          type: EventType.CMEK_ENCRYPT,
          metadata: {
            keyId
          }
        }
      });

      return { ciphertext };
    }
  });

  server.route({
    method: "GET",
    url: "/keys/:keyId/public-key",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "Get the public key for a KMS key that is used for signing and verifying data.",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.GET_PUBLIC_KEY.keyId)
      }),
      response: {
        200: z.object({
          publicKey: z.string()
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        permission
      } = req;

      const publicKey = await server.services.cmek.getPublicKey({ keyId }, permission);

      return publicKey;
    }
  });

  server.route({
    method: "GET",
    url: "/keys/:keyId/signing-algorithms",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "List all available signing algorithms for a KMS key",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.LIST_SIGNING_ALGORITHMS.keyId)
      }),
      response: {
        200: z.object({
          signingAlgorithms: z.array(z.nativeEnum(SigningAlgorithm))
        })
      }
    },
    handler: async (req) => {
      const result = await server.services.cmek.listSigningAlgorithms(
        {
          keyId: req.params.keyId
        },
        req.permission
      );
      return result;
    }
  });

  server.route({
    method: "POST",
    url: "/keys/:keyId/sign",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Sign data with a KMS key.",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.SIGN.keyId)
      }),
      body: z.object({
        signingAlgorithm: z.nativeEnum(SigningAlgorithm),
        data: z
          .string()
          .superRefine((data, ctx) => {
            if (!isBase64(data)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "data must be base64 encoded"
              });
            }
          })
          .describe(KMS.SIGN.data)
      }),
      response: {
        200: z.object({
          signature: z.string(),
          keyId: z.string().uuid(),
          signingAlgorithm: z.nativeEnum(SigningAlgorithm)
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId: inputKeyId },
        body: { data, signingAlgorithm },
        permission
      } = req;

      const result = await server.services.cmek.cmekSign({ keyId: inputKeyId, data, signingAlgorithm }, permission);

      return result;
    }
  });

  server.route({
    method: "POST",
    url: "/keys/:keyId/verify",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Verify data signatures with a KMS key.",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.VERIFY.keyId)
      }),
      body: z.object({
        data: z.string().describe(KMS.VERIFY.data),
        signature: z.string().describe(KMS.VERIFY.signature),
        signingAlgorithm: z.nativeEnum(SigningAlgorithm)
      }),
      response: {
        200: z.object({
          signatureValid: z.boolean(),
          keyId: z.string().uuid(),
          signingAlgorithm: z.nativeEnum(SigningAlgorithm)
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        body: { data, signature, signingAlgorithm },
        permission
      } = req;

      const result = await server.services.cmek.cmekVerify({ keyId, data, signature, signingAlgorithm }, permission);

      return result;
    }
  });

  server.route({
    method: "POST",
    url: "/keys/:keyId/decrypt",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Decrypt data with KMS key",
      params: z.object({
        keyId: z.string().uuid().describe(KMS.DECRYPT.keyId)
      }),
      body: z.object({
        ciphertext: base64Schema.describe(KMS.DECRYPT.ciphertext)
      }),
      response: {
        200: z.object({
          plaintext: z.string()
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const {
        params: { keyId },
        body: { ciphertext },
        permission
      } = req;

      const plaintext = await server.services.cmek.cmekDecrypt({ keyId, ciphertext }, permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: permission.orgId,
        event: {
          type: EventType.CMEK_DECRYPT,
          metadata: {
            keyId
          }
        }
      });

      return { plaintext };
    }
  });
};
