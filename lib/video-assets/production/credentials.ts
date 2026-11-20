import "server-only";

import { ECSRAMRoleCredentialsProvider } from "@alicloud/credentials";

import { VideoAssetUnavailableError } from "../errors";
import type { ProductionVideoAssetConfig } from "./config";

export type AliyunOssSessionCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
};

export interface AliyunOssCredentialSource {
  getCredentials(): Promise<AliyunOssSessionCredentials>;
}

export type EcsRamRoleProviderLike = {
  getCredentials(): Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    providerName?: string;
  }>;
};

export type EcsRamRoleProviderBuilderLike = {
  withRoleName(value: string): EcsRamRoleProviderBuilderLike;
  withDisableIMDSv1(value: boolean): EcsRamRoleProviderBuilderLike;
  withAsyncCredentialUpdateEnabled(value: boolean): EcsRamRoleProviderBuilderLike;
  withConnectTimeout(value: number): EcsRamRoleProviderBuilderLike;
  withReadTimeout(value: number): EcsRamRoleProviderBuilderLike;
  build(): EcsRamRoleProviderLike;
};

export type EcsRamRoleBuilderFactory = () => EcsRamRoleProviderBuilderLike;

function defaultBuilderFactory(): EcsRamRoleProviderBuilderLike {
  return ECSRAMRoleCredentialsProvider.builder();
}

export function createEcsRamRoleCredentialSource(
  config: ProductionVideoAssetConfig,
  builderFactory: EcsRamRoleBuilderFactory = defaultBuilderFactory,
): AliyunOssCredentialSource {
  let provider: EcsRamRoleProviderLike | undefined;
  function getProvider(): EcsRamRoleProviderLike {
    provider ??= builderFactory()
      .withRoleName(config.roleName)
      .withDisableIMDSv1(true)
      .withAsyncCredentialUpdateEnabled(false)
      .withConnectTimeout(config.imdsConnectTimeoutMs)
      .withReadTimeout(config.imdsReadTimeoutMs)
      .build();
    return provider;
  }
  return {
    async getCredentials(): Promise<AliyunOssSessionCredentials> {
      try {
        const credentials = await getProvider().getCredentials();
        if (credentials.providerName !== "ecs_ram_role") {
          throw new Error("Unexpected credential provider.");
        }
        if (
          !credentials.accessKeyId?.trim()
          || !credentials.accessKeySecret?.trim()
          || !credentials.securityToken?.trim()
        ) {
          throw new Error("Incomplete role credentials.");
        }
        return {
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.accessKeySecret,
          securityToken: credentials.securityToken,
        };
      } catch {
        throw new VideoAssetUnavailableError();
      }
    },
  };
}
