/**
 * The shipped prompt catalog (#375) imports skill documents as text, not as packaged skill
 * references: what the store seeds from must be the bytes the repository ships, and the reference
 * is rebuilt from the stored body at agent initialization. Vite serves `?raw` natively; the
 * documents are named `skill-body.md` because Flue's build reserves `SKILL.md` for skill imports.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
