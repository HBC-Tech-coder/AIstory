import type { Metadata } from "next";
import Link from "next/link";
import { localePath } from "@/lib/i18n/navigation";
import { isValidLocale } from "@/lib/i18n/utils";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";

export const metadata: Metadata = {
  title: "隐私政策 — AIstory",
  description: "AIstory 公开测试阶段的隐私与数据处理说明。",
};

export default async function PrivacyPage({
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
        隐私政策
      </h1>
      <p className="mb-12 text-sm text-clay-500">
        生效日期：2026 年 7 月 28 日 &nbsp;|&nbsp; 最后更新：2026 年 8 月 9 日
      </p>

      <div className="hairline-full mb-12 w-full" />

      <div className="space-y-10 text-[15px] leading-[1.85] text-clay-800">
        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            适用范围与当前状态
          </h2>
          <p>
            AIstory 是互动影游与 AI 创作工具，目前处于公开测试和功能验证阶段。本政策说明当前代码及公开测试环境实际采用的数据处理方式。手机号短信验证和账户系统已经启用；充值支付、平台代付模型调用和正式商业运营仍未启用。
          </p>
          <p className="mt-3">
            正式公开运营前，本页将根据实际运营主体、部署地区、身份与短信供应商、模型供应商及适用法律进行补充并接受必要的法律审查。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            匿名访问与账户
          </h2>
          <p>
            您无需注册即可读取已经公开的内容、作者锁定剧情、静态模板和已有缓存。这些路径不会为了浏览而触发平台代付模型调用。
          </p>
          <p className="mt-3">
            只有当某项操作即将产生平台代付的文字、图片、视觉理解、配音或视频调用，并且没有可用缓存时，系统才会先显示预计积分，再要求完成手机号验证。若验证或预授权没有完成，模型调用不会开始。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            手机号验证信息
          </h2>
          <p>
            当前公开测试服务会在服务端规范化手机号，以带服务端密钥的 HMAC
            生成稳定账户标识，并只在普通界面和管理列表显示掩码。验证码仅保存 HMAC
            校验值，并设置有效期、请求频率、错误尝试次数等安全限制；登录状态使用
            HttpOnly 的服务端签名会话 Cookie。
          </p>
          <p className="mt-3">
            当前验证码通过阿里云短信服务投递。为完成发送，规范化手机号、短信签名、模板编号和一次性验证码会被传给该供应商；供应商可能按其服务规则处理必要的投递、状态和安全日志。AIstory 不在普通界面、应用日志或管理列表中回显完整手机号或验证码。验证码仅在短期有效，验证成功后立即失效；账户身份映射、登录审计和依法或为安全所必需的记录会按相应目的继续保存。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            用户自备 API 密钥（BYOK）
          </h2>
          <p>
            BYOK 密钥默认仅保存在当前浏览器的 sessionStorage。只有您明确选择“记住在本机”时，才会保存到
            localStorage。当前实现不声称这些浏览器存储已经加密；请勿在不受信任或多人共用设备上选择长期保存。
          </p>
          <p className="mt-3">
            某些兼容接口可能需要通过服务端代理完成单次请求。此类代理不得把密钥放入 URL，也不会把密钥写入账户仓储、生成缓存、审计记录或应用日志。模型供应商仍可能依据您与其之间的条款处理调用信息并收取费用。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            游戏、创作与服务端记录
          </h2>
          <p>
            游戏 Session 主要由浏览器携带，其中可能包括故事进度、选择历史、角色状态、语言、画面与叙事风格设置。根据您使用的功能，以下数据也可能在服务端或本地服务目录中保存：
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-6">
            <li>为减少重复生成而保存的文字、图片、配音或其他缓存结果。</li>
            <li>账户资料、积分账户和不可变积分流水。</li>
            <li>生成任务状态、重试与错误信息、供应商和成本计量摘要。</li>
            <li>创作者项目素材、工作流版本及必要的来源记录。</li>
            <li>管理员审计、安全频控、登录挑战及故障排查记录。</li>
          </ul>
          <p className="mt-3">
            因此，我们不承诺游戏结束后所有数据都会立即或自动删除。待生产环境确定后，将按数据类别公布更具体的保存期限和删除机制。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            AI 与基础设施供应商
          </h2>
          <p>
            当您主动使用文字、图片、视觉理解、TTS 或视频生成功能时，为完成请求，故事提示词、对话选择、参考图、必要上下文、语言与生成参数可能会传给您选择的模型或基础设施供应商。我们会尽量只传输完成当前功能所需的数据。短信验证由阿里云短信服务处理；模型能力与短信能力是相互独立的供应商链路。
          </p>
          <p className="mt-3">
            使用 BYOK 时，相关处理同时受您与供应商之间的账户和隐私条款约束。使用平台代付能力时，将在正式上线前根据实际供应商补充第三方处理说明，不以当前本地 provider
            契约代替生产告知。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            统计、用途与不出售承诺
          </h2>
          <p>
            部署方可以选择启用 Umami，用于页面访问、功能使用和错误等内容无关统计。当前埋点设计不发送故事正文、提示词、上传素材或 API
            密钥，但实际网络元数据和处理范围仍取决于最终部署方式与统计服务配置。
          </p>
          <p className="mt-3">
            数据仅用于提供和保护服务、恢复进度、完成生成、结算积分、支持创作、分析稳定性及履行法律义务。当前实现不出售个人信息，也未接入基于个人信息的广告投放。若用途发生实质变化，将先更新本政策并依法取得必要授权。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            安全与保存原则
          </h2>
          <p>
            我们遵循最小必要、分权访问和默认不回显敏感信息的原则。密钥、完整手机号、验证码和支付敏感信息不得进入普通日志或前端响应；管理员操作和积分变动需要保留可追溯审计。
          </p>
          <p className="mt-3">
            数据原则上仅保存到实现相应功能、安全审计、争议处理或法律义务所需的期限。当前公开测试环境及本地创作目录中的缓存、任务、素材和账本可能持续保留到测试者清理、账户操作或后续迁移；它们不应被视为正式商业运营的最终保存期限。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            您的权利
          </h2>
          <p>
            在适用法律规定的范围内，您可以请求查阅、更正、删除或复制与您有关的数据，撤回可撤回的授权，清除浏览器中保存的 BYOK
            配置，或对处理方式提出异议。部分审计、结算或依法需要保留的数据可能无法立即删除，我们会在正式运营规则中说明原因和处理期限。
          </p>
          <p className="mt-3">
            当前尚未公布正式的数据权利受理渠道。公开运营前，本页会补充运营主体、投诉与数据权利渠道以及响应时限；在此之前请勿将页面中不存在的邮箱或社交账号视为正式受理渠道。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            未成年人保护
          </h2>
          <p>
            未成年人应在监护人同意和指导下使用 AIstory，不应提交不必要的个人信息、私密图片或他人的身份资料。正式公开运营前，将结合服务地区、内容分级和渠道要求完善年龄提示、监护机制与未成年人数据规则。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl text-clay-900">
            政策更新与联系说明
          </h2>
          <p>
            功能、供应商或数据处理方式变化时，我们会更新本页并修改“最后更新”日期。当前页面是公开测试披露，不代表已经完成正式商业运营所需的全部法律审查、备案或监管审批。
          </p>
          <p className="mt-3">
            正式运营主体、投诉渠道和客服联系方式尚未确定，因此本页不提供推测性的邮箱、地址或主体名称。相关信息会在生产发布前补齐并经过法律审查。
          </p>
        </section>
      </div>

      <div className="hairline-full mb-8 mt-16 w-full" />

      <footer className="pb-10 text-center text-[11px] text-clay-500">
        <p>© 2026 AIstory · 公开测试说明</p>
        <p className="mt-2">
          <Link
            href={lp("/terms")}
            className="transition-colors hover:text-ember-500"
          >
            查看服务条款
          </Link>
        </p>
      </footer>
    </main>
  );
}
