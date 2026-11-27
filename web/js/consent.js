import { api, clear, el, openURL, toast } from "./api.js";

/**
 * First-run & reviewable Privacy / Usage Notice modal (#191).
 * When initialGate is true, the user must explicitly accept (saving their
 * chosen opt-in preferences) or decline & quit. Before acceptance, the Go
 * backend strictly blocks telemetry, autostart registration, and background
 * auto-update downloads.
 */
export function openPrivacyConsentDialog(settingsObj = {}, { initialGate = false, onAccepted = null } = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById("privacy-consent-dialog");
    if (existing) {
      try { existing.close(); } catch {}
      existing.remove();
    }

    const s = settingsObj || {};
    const siteBase = String(s.siteBase || "https://handraw-style.com").replace(/\/+$/, "");
    // On first-run gate, honor strict opt-in defaults for telemetry and launch-at-login.
    const initTelemetry = initialGate ? false : !s.telemetryDisabled;
    const initLaunch = initialGate ? false : Boolean(s.launchAtLogin);
    const initAutoUpdate = (s.autoUpdateMode || (s.autoCheckUpdate === false ? "off" : "auto")) !== "off";

    const telChk = el("input", {
      id: "consent-telemetry",
      name: "telemetryEnabled",
      type: "checkbox",
      checked: initTelemetry,
    });
    const launchChk = el("input", {
      id: "consent-launch",
      name: "launchAtLogin",
      type: "checkbox",
      checked: initLaunch,
    });
    const updChk = el("input", {
      id: "consent-autoupdate",
      name: "autoUpdate",
      type: "checkbox",
      checked: initAutoUpdate,
    });

    const statusBox = el("div", {
      class: "consent-status",
      role: "status",
      "aria-live": "polite",
      hidden: true,
    });

    const dlg = el("dialog", {
      id: "privacy-consent-dialog",
      class: "modal modal-consent",
      closedby: initialGate ? "none" : "any",
      "aria-labelledby": "consent-dialog-title",
    });

    if (initialGate) {
      dlg.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        statusBox.textContent = "请先选择「同意并开始使用」或「暂不同意并退出」。";
        statusBox.hidden = false;
      });
    }

    const finish = (accepted, updatedSettings = null) => {
      try {
        if (dlg.open) dlg.close(accepted ? "accept" : "cancel");
      } catch {}
      dlg.remove();
      if (accepted && typeof onAccepted === "function") {
        onAccepted(updatedSettings);
      }
      resolve({ accepted, settings: updatedSettings });
    };

    const declineBtn = el("button", {
      type: "button",
      class: "btn",
      onClick: async () => {
        if (!initialGate) {
          finish(false);
          return;
        }
        declineBtn.disabled = true;
        acceptBtn.disabled = true;
        statusBox.textContent = "正在退出手绘风工作台…（若在浏览器调试模式下，可直接关闭当前标签页）";
        statusBox.hidden = false;
        try {
          await api("POST", "/api/app/quit", {});
        } catch {}
      },
    }, initialGate ? "暂不同意并退出" : "关闭");

    const acceptBtn = el("button", {
      type: "submit",
      class: "btn btn-primary",
    }, initialGate ? "同意并开始使用" : "保存偏好设置");

    const form = el("form", {
      class: "col consent-form",
      onSubmit: async (ev) => {
        ev.preventDefault();
        acceptBtn.disabled = true;
        declineBtn.disabled = true;
        statusBox.hidden = true;
        try {
          const res = await api("PATCH", "/api/settings", {
            acceptPrivacyConsent: true,
            telemetryDisabled: !telChk.checked,
            launchAtLogin: launchChk.checked,
            autoUpdateMode: updChk.checked ? "auto" : "off",
            autoCheckUpdate: updChk.checked,
          });
          if (!initialGate) toast("隐私与使用偏好已保存");
          finish(true, res?.settings || null);
        } catch (err) {
          statusBox.textContent = err?.message || "保存设置失败，请重试";
          statusBox.hidden = false;
          acceptBtn.disabled = false;
          declineBtn.disabled = false;
        }
      },
    },
      el("div", { class: "consent-head" },
        el("div", { class: "consent-badge" }, "使用须知与隐私偏好"),
        el("h1", { id: "consent-dialog-title", class: "consent-title" },
          initialGate ? "欢迎使用手绘风工作台" : "隐私与数据使用说明"
        ),
        el("p", { class: "consent-sub" },
          initialGate
            ? "在开始使用前，请确认以下本地权限与联网偏好。点击「同意并开始使用」前，本软件不会发送任何统计或错误数据，也不会写入系统开机自启。"
            : "你可以在这里随时调整匿名诊断、开机自启与自动更新偏好，所有设置立即生效。"
        )
      ),
      el("div", { class: "consent-promises" },
        el("div", { class: "consent-promise" },
          el("span", { class: "consent-p-ico", "aria-hidden": "true" }, "🔒"),
          el("div", null,
            el("strong", null, "本地数据归你所有"),
            el("span", null, "提示词、参考图、本地作品与第三方 API Key 仅保存在本机（密钥存入系统钥匙串），绝不私自上传。")
          )
        ),
        el("div", { class: "consent-promise" },
          el("span", { class: "consent-p-ico", "aria-hidden": "true" }, "🌐"),
          el("div", null,
            el("strong", null, "开源透明，按需联网"),
            el("span", null, "客户端代码公开可审计；仅在你登录账号、调用官网模型/市场或开启下方开关时产生联网请求。")
          )
        ),
        el("div", { class: "consent-promise" },
          el("span", { class: "consent-p-ico", "aria-hidden": "true" }, "🎨"),
          el("div", null,
            el("strong", null, "生图可见性清晰可控"),
            el("span", null, "自带第三方接口生图 100% 仅存本地；使用官网模型时可在「设置 → 隐私、数据与协议」随时设为仅自己可见。")
          )
        )
      ),
      el("fieldset", { class: "consent-fieldset" },
        el("legend", { class: "consent-legend" }, "可选权限与联网偏好（随时可在「设置」修改）"),
        el("label", { for: "consent-telemetry", class: "consent-opt" },
          telChk,
          el("span", { class: "consent-opt-copy" },
            el("strong", null, "发送匿名使用统计与脱敏崩溃报告", el("span", { class: "badge" }, "默认关闭")),
            el("small", null, "仅含随机匿名 ID、版本号、系统与脱敏错误/崩溃堆栈，不含提示词、图片、路径与密钥；开启可帮我们更快修复闪退，随时可在设置查看上报内容。")
          )
        ),
        el("label", { for: "consent-launch", class: "consent-opt" },
          launchChk,
          el("span", { class: "consent-opt-copy" },
            el("strong", null, "开机自动启动（托盘静默待命）", el("span", { class: "badge" }, "默认关闭")),
            el("small", null, "仅写入当前用户级登录自启项，方便随时唤出全局快门窗，不改动系统全局配置。")
          )
        ),
        el("label", { for: "consent-autoupdate", class: "consent-opt" },
          updChk,
          el("span", { class: "consent-opt-copy" },
            el("strong", null, "自动检查并更新客户端与资源包", el("span", { class: "badge badge-ok" }, "推荐")),
            el("small", null, "空闲时后台下载并严格校验 ed25519 数字签名，退出软件时平滑升级，也可在设置改为仅提醒或关闭。")
          )
        )
      ),
      el("div", { class: "consent-links" },
        el("span", { class: "muted" }, "开源协议与说明："),
        el("button", {
          type: "button",
          class: "consent-link-btn",
          onClick: () => openURL("https://github.com/yang0/handraw-client"),
        }, "GitHub 开源仓库 ↗"),
        el("span", { class: "muted", "aria-hidden": "true" }, "·"),
        el("button", {
          type: "button",
          class: "consent-link-btn",
          onClick: () => openURL(siteBase),
        }, "手绘风官网 ↗")
      ),
      statusBox,
      el("div", { class: "consent-foot" },
        el("span", { class: "consent-foot-note" },
          initialGate ? "点击「同意并开始使用」即表示你已阅读并认可上述说明。" : ""
        ),
        el("div", { class: "row", style: { gap: "8px" } }, declineBtn, acceptBtn)
      )
    );

    dlg.appendChild(el("div", { class: "modal-inner consent-inner" }, form));
    document.body.appendChild(dlg);
    dlg.showModal();
    requestAnimationFrame(() => acceptBtn.focus());
  });
}
