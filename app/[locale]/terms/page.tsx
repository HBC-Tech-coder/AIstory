import type { Metadata } from "next";
import Link from "next/link";
import { localePath } from "@/lib/i18n/navigation";
import { isValidLocale } from "@/lib/i18n/utils";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";

export const metadata: Metadata = {
  title: "服务条款 — AIstory",
  description: "AIstory 本地内测阶段的服务与使用规则。",
};

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const lp = (path: string) => localePath(path, locale);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16 md:px-16 md:py-24">
      <Link
        href={lp("/")}
        className="mb-12 inline-flex items-center gap-2 text-sm text-clay-500 transition-colors hover:text-ember-500"
      >
        <i className="fa-solid fa-arrow-left text-xs" />
        <span>返回首页</span>
      </Link>

      <h1 className="mb-4 font-serif text-3xl text-clay-900 md:text-4xl">
        服务条款
      </h1>
      <p className="mb-12 text-sm text-clay-500">
        生效日期：2026 年 7 月 28 日 &nbsp;|&nbsp; 最后更新：2026 年 7 月 28 日
      </p>

      <div className="hairline-full mb-12 w-full" />

      <div className="space-y-10 text-[15px] leading-[1.85] text-clay-800">
        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            服务与内测状态
          </h2>
          <p>
            AIstory 提供互动影游、分支剧情、角色与世界线管理，以及文字、图片、视觉理解、配音、视频和本地创作工具等能力。不同能力可能处于已实现、局部实现、仅本地可用或待配置状态。
          </p>
          <p className="mt-3">
            当前版本是本地内测和工程验证版本，不代表生产服务、正式运营主体、真实短信、充值支付或全部供应商连接已经上线。请以界面中的实际状态和调用提示为准。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            匿名体验与账户
          </h2>
          <p>
            匿名用户可以体验不产生平台模型费用的公开内容、作者锁定剧情、静态模板和已有缓存。只要没有新的平台代付模型调用，就不会因为浏览或本地剧情推进而强制注册。
          </p>
          <p className="mt-3">
            当某项操作即将触发平台代付的文字、图片、视觉理解、TTS 或视频调用且缓存未命中时，系统应先给出积分预估，再要求完成手机号验证。未登录、余额不足、定价未配置或安全检查未通过时，调用必须停止。
          </p>
          <p className="mt-3">
            当前真实短信和生产身份系统尚未启用，本地测试登录不代表手机号账户已经可以在公开环境注册。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            BYOK 与费用责任
          </h2>
          <p>
            您可以在支持的能力中配置自己的模型 API 密钥（BYOK）。BYOK 调用由您选择的供应商处理并向您的供应商账户计费，不扣除 AIstory
            平台积分；您应自行了解供应商价格、配额、地区和内容政策。
          </p>
          <p className="mt-3">
            AIstory 不会在缺少相应 BYOK 能力时静默改用平台密钥，也不会因为您关闭预生成而在后台产生预测调用。预生成 0
            层表示选择后再生成；当前外测最多开放下一层预生成。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            平台积分与计费
          </h2>
          <p>
            平台代付能力按服务端发布的版本化价格政策执行。调用前会预留预计积分（reserve）；成功后按供应商实际结算回执或已发布价目结算（settle）；失败、取消或缓存命中时应退款或不扣积分（refund/零扣）。
          </p>
          <p className="mt-3">
            当供应商没有返回可验证的实际成本时，系统只能按管理员发布的价目表计算，并明确标记为
            price_catalog，不会把估算冒充供应商真实结算。当前默认定价思路为平台成本乘以版本化倍数，但只有实际启用并公布的政策才生效。
          </p>
          <p className="mt-3">
            首次成功注册的默认政策为赠送 1000
            积分，但具体数量以注册时实际启用的版本化政策为准。首次赠送按账户全局幂等，仅可领取一次。积分仅用于平台内能力计量，不具有现金价值，不可转让、提现或兑换法定货币。
          </p>
          <p className="mt-3">
            当前没有启用充值、支付、提现或创作者结算，不应向任何页面中未正式上线的入口付款。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            AI 输出与标识
          </h2>
          <p>
            AI 生成或改写的文字、图片、语音和视频可能不准确、不完整、不适当，或与事实、版权和特定用途要求不符。您应在发布或依赖这些内容前自行核查，不能把 AI
            输出当作医疗、法律、金融或其他专业意见。
          </p>
          <p className="mt-3">
            对依法或按产品规则需要标识为 AI 生成、合成或改写的内容，您不得移除、遮挡、伪造相关标识，也不得以足以误导他人的方式冒充真实人物、真实事件或人工原创。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            用户输入与上传素材
          </h2>
          <p>
            您应确保对提交的提示词、剧本、图片、声音、视频、角色设定、商标和其他素材拥有必要权利或合法授权，并对内容的合法性承担责任。请勿上传他人的敏感身份资料、私密内容或未经授权的真人素材。
          </p>
          <p className="mt-3">
            为完成您请求的功能，必要输入和上下文可能传给所选模型或基础设施供应商；使用 BYOK 时还受您与该供应商之间的服务和内容条款约束。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            生成内容与知识产权
          </h2>
          <p>
            生成内容可否取得权利、权利范围及能否商业使用，取决于适用法律、您的创作性贡献、输入素材权利和所选模型供应商条款。AIstory
            不对生成内容作绝对所有权、独占性或不侵权保证。
          </p>
          <p className="mt-3">
            AIstory 仓库当前代码许可标识为 AGPL-3.0-only。第三方代码、模型、字体、图标、工作流、素材和生成服务继续适用各自的许可证或服务条款；本条款不会替代或扩大这些第三方授权。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            禁止行为
          </h2>
          <p>使用 AIstory 时，您不得：</p>
          <ul className="mt-3 list-disc space-y-1 pl-6">
            <li>制作、传播或协助制作违法、侵权、欺诈、骚扰或危害他人的内容。</li>
            <li>冒充他人，伪造身份、来源、授权、AI 标识或系统状态。</li>
            <li>绕过登录、权限、积分预授权、计费、速率限制、内容策略或安全边界。</li>
            <li>重复提交付费任务、恶意占用队列/GPU，或干扰其他用户和本地服务。</li>
            <li>探测、攻击、植入恶意代码、实施路径穿越、SSRF、凭据窃取或未授权访问。</li>
            <li>以违反第三方供应商、渠道、模型或素材许可的方式使用相关能力。</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            数据与隐私
          </h2>
          <p>
            游戏 Session 主要由浏览器携带，但缓存、账户和积分流水、生成任务、项目素材、审计与安全记录可能按功能需要保存。具体处理方式请阅读{" "}
            <Link
              href={lp("/privacy")}
              className="text-ember-500 underline decoration-clay-900/20 underline-offset-2 transition-colors hover:text-ember-400"
            >
              隐私政策
            </Link>
            。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            内测可用性与责任限制
          </h2>
          <p>
            内测功能按“现状”和“可用”状态提供，可能出现中断、排队、限流、输出失败、数据迁移或功能调整。视频或图片生成失败时，系统会尽量保持故事和已有静态内容可继续使用，但不保证所有功能持续可用或结果符合特定目的。
          </p>
          <p className="mt-3">
            在适用法律允许的范围内，各方应对自身违法、侵权或违反第三方条款的行为负责。正式运营前，将由确定的运营主体结合服务地区和业务模式完善责任限制、消费者权益、退款与争议处理规则；当前文字不排除依法不能排除的责任。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            未成年人
          </h2>
          <p>
            未成年人须在监护人同意和指导下使用 AIstory。监护人应帮助判断内容是否适龄、管理 BYOK
            供应商费用和平台积分，并避免未成年人提交个人敏感信息或未经授权的素材。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            条款更新与正式运营信息
          </h2>
          <p>
            功能、计费方式、供应商或法律要求变化时，本条款可能更新，并以页面上的“最后更新”日期提示。重大变化在正式运营后将按适用规则另行通知。
          </p>
          <p className="mt-3">
            当前正式运营主体、客服/投诉渠道和争议管辖尚未确定，本页面不会虚构名称、邮箱、地址或管辖法院。生产发布前将补齐这些信息，并完成适用的法律审查、备案或审批判断。
          </p>
        </section>
      </div>

      <div className="hairline-full mb-8 mt-16 w-full" />

      <footer className="pb-10 text-center text-[11px] text-clay-500">
        <p>© 2026 AIstory · 本地内测说明</p>
        <p className="mt-2">
          <Link
            href={lp("/privacy")}
            className="transition-colors hover:text-ember-500"
          >
            查看隐私政策
          </Link>
        </p>
      </footer>
    </main>
  );
}
