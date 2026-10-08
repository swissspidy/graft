/**
 * Side-effect imports of stylesheets (`import './admin.css'`) have no runtime
 * type of their own: webpack handles them and TypeScript never sees the file.
 */
declare module '*.css';
