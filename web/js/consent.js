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
    // Before acceptance, backend gates still block telemetry/autostart/auto-update;
    // in the first-run dialog itself, pre-check telemetry and launch-at-login so
    // users can accept with one click or uncheck before continuing (#197, #198).
    const initTelemetry = initialGate ? true : !s.telemetryDisabled;
    const initLaunch = initialGate ? true : Boolean(s.launchAtLogin);

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
      class: "btn btn-ghost",
      onClick: async () => {
        if (!initialGate) {
          finish(false);
          return;
        }
        declineBtn.disabled = true;
        acceptBtn.disabled = true;
        statusBox.textContent = "正在退出手绘风工作台…";
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
            autoUpdateMode: "auto",
            autoCheckUpdate: true,
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
        el("h1", { id: "consent-dialog-title", class: "consent-title" },
          initialGate ? "欢迎使用手绘风工作台" : "隐私与使用偏好"
        ),
        el("p", { class: "consent-sub" },
          initialGate
            ? "点击同意前不会发送任何数据；以下偏好随时可在「设置」修改。"
            : "随时调整诊断与开机自启偏好，保存后立即生效。"
        )
      ),
      el("div", { class: "consent-promises" },
        el("div", { class: "consent-promise" },
          el("span", { class: "consent-p-ico", "aria-hidden": "true" }, "🔒"),
          el("strong", null, "数据仅存本机"),
          el("span", null, "提示词、图片与密钥不上传")
        ),
        el("div", { class: "consent-promise" },
          el("span", { class: "consent-p-ico", "aria-hidden": "true" }, "🌐"),
          el("strong", null, "开源按需联网"),
          el("span", null, "代码公开可审计")
        ),
        el("div", { class: "consent-promise" },
          el("span", { class: "consent-p-ico", "aria-hidden": "true" }, "🎨"),
          el("strong", null, "可见性可控"),
          el("span", null, "随时设为仅自己可见")
        )
      ),
      el("fieldset", { class: "consent-fieldset" },
        el("legend", { class: "consent-legend" }, "体验与诊断偏好"),
        el("div", { class: "consent-opt-list" },
          el("label", { for: "consent-telemetry", class: "consent-opt" },
            telChk,
            el("span", { class: "consent-opt-copy" },
              el("strong", null, "匿名使用统计与脱敏崩溃报告"),
              el("small", null, "帮助我们更好地改善产品体验与修复问题，不含你的个人隐私数据")
            )
          ),
          el("label", { for: "consent-launch", class: "consent-opt" },
            launchChk,
            el("span", { class: "consent-opt-copy" },
              el("strong", null, "开机静默启动"),
              el("small", null, "后台托盘待命、随时唤出；从 X 等平台一键收集提示词时，也需客户端处于运行状态")
            )
          )
        )
      ),
      statusBox,
      el("div", { class: "consent-foot" },
        el("div", { class: "consent-links" },
          el("button", {
            type: "button",
            class: "consent-link-btn",
            onClick: () => openURL("https://github.com/yang0/handraw-client"),
          }, "GitHub 开源 ↗"),
          el("span", { class: "muted", "aria-hidden": "true" }, "·"),
          el("button", {
            type: "button",
            class: "consent-link-btn",
            onClick: () => openURL(siteBase),
          }, "官网 ↗")
        ),
        el("div", { class: "consent-actions" }, declineBtn, acceptBtn)
      )
    );

    dlg.appendChild(el("div", { class: "modal-inner consent-inner" }, form));
    document.body.appendChild(dlg);
    dlg.showModal();
    requestAnimationFrame(() => acceptBtn.focus());
  });
}
