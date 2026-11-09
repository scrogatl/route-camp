// BEGIN LICENSE HEADER
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
//
// Part of route-camp. Licensed under the Apache License, Version 2.0;
// see the LICENSE and NOTICE files in the repository root.
// Redistributions must retain this notice and the NOTICE file.
//
// Commit history (date time tz | author <email> | commit | message):
//   2026-11-05 18:02:37 -0500 | Scott Rogers <scott@scottandrewrogers.com> | dfd0e74 | Adopt the rally-route-finder look: cards, header, blue/orange palette
//   2026-11-05 17:07:59 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 88bba4f | Route from a folder, optimize review, stop editing, show and plans
//   2026-11-05 16:31:14 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 30cb6a0 | Undo bar after untag all
//   2026-11-05 14:26:38 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 487ddb8 | Replace native dialogs with in-page ones; add Clear map
// END LICENSE HEADER
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
function open(
  message: string,
  opts: { input?: string; cancel?: boolean; ok?: string; cancelLabel?: string },
): Promise<string | null> {
  const box = getDialog();
  const text = document.createElement("p");
  text.textContent = message;
  const input = document.createElement("input");
  input.value = opts.input ?? "";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.textContent = opts.ok ?? "OK";
  ok.className = "primary";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = opts.cancelLabel ?? "Cancel";
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

// Two-way choice such as Accept / Reject. True for the first button, false for the second or Escape.
export async function askDecision(message: string, accept: string, reject: string): Promise<boolean> {
  return (await open(message, { cancel: true, ok: accept, cancelLabel: reject })) !== null;
}

export function askText(message: string, initial = ""): Promise<string | null> {
  return open(message, { input: initial, cancel: true });
}

// Non-blocking bar at the bottom of the page, for a change that can be undone. It goes away after
// UNDO_MS, when dismissed, when its action runs, or when hideUndo() is called (the app calls that
// before every change, so an old undo can't reverse a newer one).
const UNDO_MS = 10_000;
let undoBar: HTMLElement | null = null;
let undoTimer: number | undefined;

export function hideUndo(): void {
  window.clearTimeout(undoTimer);
  undoBar?.remove();
  undoBar = null;
}

export function showUndo(message: string, action: () => void, label = "Undo"): void {
  hideUndo();
  const text = document.createElement("span");
  text.textContent = message;
  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.textContent = label;
  actionButton.onclick = () => {
    hideUndo();
    action();
  };
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "×";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.onclick = hideUndo;

  undoBar = document.createElement("div");
  undoBar.id = "undo-bar";
  undoBar.setAttribute("role", "status");
  undoBar.append(text, actionButton, dismiss);
  document.body.append(undoBar);
  undoTimer = window.setTimeout(hideUndo, UNDO_MS);
}
