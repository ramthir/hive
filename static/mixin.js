// Method groups of the notes page live in their own files as plain classes; this copies their methods onto NotesApp,
// so `this` is the page element and the code reads as it did when it was one big class.
export function mixin(target, ...groups) {
  for (const group of groups) {
    for (const name of Object.getOwnPropertyNames(group.prototype)) {
      if (name !== 'constructor') Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(group.prototype, name));
    }
  }
}
