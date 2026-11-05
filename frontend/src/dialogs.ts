// In-page replacements for alert/confirm/prompt. Native dialogs are blocked in some embedded
// browsers (confirm() silently returns false there), so the app never relies on them.

let dialog: HTMLDialogElement | null = null;

function getDialog(): HTMLDialogElement {
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "app-dialog";
    document.body.append(dialog);
  }
  return dialog;
}

// Shows a message with optional text input. Resolves with the input value (or "" without one)
// on OK, or null on Cancel / Escape.
function open(message: string, opts: { input?: string; cancel?: boolean; ok?: string }): Promise<string | null> {
  const box = getDialog();
  const text = document.createElement("p");
  text.textContent = message;
  const input = document.createElement("input");
  input.value = opts.input ?? "";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.textContent = opts.ok ?? "OK";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const buttons = document.createElement("div");
  buttons.className = "dialog-buttons";
  buttons.append(...(opts.cancel ? [cancel, ok] : [ok]));
  const form = document.createElement("form");
  form.append(text, ...(opts.input !== undefined ? [input] : []), buttons);
  box.replaceChildren(form);

  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      box.close();
      resolve(value);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(opts.input !== undefined ? input.value : "");
    });
    cancel.addEventListener("click", () => finish(null));
    box.addEventListener("cancel", () => resolve(null), { once: true }); // Escape key
    box.showModal();
    (opts.input !== undefined ? input : ok).focus();
  });
}

export function showMessage(message: string): Promise<void> {
  return open(message, {}).then(() => undefined);
}

export async function askConfirm(message: string, ok = "OK"): Promise<boolean> {
  return (await open(message, { cancel: true, ok })) !== null;
}

export function askText(message: string, initial = ""): Promise<string | null> {
  return open(message, { input: initial, cancel: true });
}
