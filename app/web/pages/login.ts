import { h } from "../../../src/utils/dom";
import { api } from "../api";
import type { Page } from "../ui";

export function loginPage(): Page {
  const input = h("input", { class: "input", type: "password", placeholder: "密码", autocomplete: "current-password", autofocus: true });
  const button = h("button", { class: "btn primary", type: "submit" }, "进入书库");
  const error = h("div", { class: "error" });
  const form = h("form", {}, input, button, error);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    button.disabled = true;
    error.textContent = "";
    api
      .post("/api/login", { password: input.value })
      .then(() => {
        const next = new URLSearchParams(location.search).get("next");
        location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      })
      .catch((err: Error) => {
        error.textContent = err.message;
        button.disabled = false;
        input.select();
      });
  });
  return { el: h("div", { class: "login" }, h("div", { class: "logo" }, "📚"), h("h1", {}, "Bili Reader 有声书库"), form) };
}
