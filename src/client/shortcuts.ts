/** True while a modal dialog (the raw-data drawer) owns the keyboard; global shortcuts stand down. */
export function modalOpen(): boolean {
  return document.querySelector('dialog:modal') !== null;
}
