"use client";

import { useEffect, useMemo, useState } from "react";

import { readStoredModelConfig } from "@/lib/clientModelConfig";
import { readStoredTtsConfig } from "@/lib/clientTtsConfig";
import {
  diagnoseByokCapabilities,
  findByokCapability,
} from "@/lib/credentials/byokDiagnostics";
import { useI18n } from "@/lib/i18n/client";
import {
  buildUsageDisclosure,
  formatUsageDisclosure,
  type UsageAction,
  type UsageCapability,
} from "@/lib/usageDisclosure";
import type { BranchPrefetchDepth } from "@infiplot/types";

type ReadyMap = Partial<Record<UsageCapability, boolean>>;

export function readBrowserByokReady(): ReadyMap {
  const report = diagnoseByokCapabilities(
    readStoredModelConfig(),
    readStoredTtsConfig(),
  );
  return Object.fromEntries(
    report.capabilities.map((item) => [
      item.capability,
      findByokCapability(report, item.capability).status === "ready",
    ]),
  ) as ReadyMap;
}

export function UsageDisclosureNote({
  action,
  audioEnabled = false,
  prefetchDepth = 0,
  refreshKey,
  variant = "accent",
  className = "",
}: {
  action: UsageAction;
  audioEnabled?: boolean;
  prefetchDepth?: BranchPrefetchDepth;
  refreshKey?: unknown;
  variant?: "accent" | "plain";
  className?: string;
}) {
  const { locale } = useI18n();
  const [byokReady, setByokReady] = useState<ReadyMap>({});

  useEffect(() => {
    setByokReady(readBrowserByokReady());
  }, [refreshKey]);

  const text = useMemo(
    () =>
      formatUsageDisclosure(
        buildUsageDisclosure({
          action,
          audioEnabled,
          prefetchDepth,
          byokReady,
        }),
        locale,
      ),
    [action, audioEnabled, byokReady, locale, prefetchDepth],
  );

  const variantClassName =
    variant === "plain"
      ? ""
      : "border-l-2 border-ember-500/45 pl-3";

  return (
    <div
      className={`flex items-start gap-2 text-left text-[11px] leading-5 text-clay-500 ${variantClassName} ${className}`}
      role="note"
    >
      <i
        className="fa-solid fa-circle-info mt-[5px] shrink-0 text-[10px] text-ember-500"
        aria-hidden="true"
      />
      <span>{text}</span>
    </div>
  );
}
