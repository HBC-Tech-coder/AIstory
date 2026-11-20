import type { Metadata } from "next";

import { CreditCardRedeemPanel } from "@/components/CreditCardRedeemPanel";

export const metadata: Metadata = {
  title: "兑换积分卡 · AIstory",
  robots: { index: false, follow: false },
};

export default function CreditCardRedeemPage() {
  return (
    <main className="min-h-screen bg-stone-100 px-4 py-12">
      <CreditCardRedeemPanel />
    </main>
  );
}
