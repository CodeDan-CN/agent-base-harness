import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const workspaces = manifest.workspaces.map((directory) => ({
  directory,
  ...JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')),
}));
const clientOnly = new Set([
  'apps/mobile',
  'apps/web',
  'apps/desktop',
  'apps/cli',
  'packages/app-ui',
  'packages/client-sdk',
  'packages/protocol',
]);
const browserOnly = new Set([
  'apps/mobile',
  'apps/web',
  'packages/app-ui',
  'packages/client-sdk',
  'packages/protocol',
]);
const errors = [];
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(file);
    return /\.tsx?$/.test(file) ? [file] : [];
  });
}
for (const workspace of workspaces) {
  for (const file of files(path.join(root, workspace.directory, 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === 'require')
      )
        specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) check(specifier.text);
      ts.forEachChild(node, visit);
    }
    function check(specifier) {
      if (
        browserOnly.has(workspace.directory) &&
        path.relative(root, file) !== 'packages/client-sdk/src/node-account-storage.ts' &&
        (specifier.startsWith('node:') ||
          builtinModules.includes(specifier) ||
          specifier === 'electron' ||
          specifier === 'better-sqlite3')
      )
        errors.push(file + ': forbidden browser dependency ' + specifier);
      let target;
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        target = workspaces.find((candidate) =>
          resolved.startsWith(path.join(root, candidate.directory) + path.sep),
        );
      } else if (specifier === '@client-contracts')
        target = workspaces.find((candidate) => candidate.directory === 'packages/protocol');
      else if (specifier.startsWith('@ui/'))
        target = workspaces.find((candidate) => candidate.directory === 'packages/app-ui');
      else
        target = workspaces.find(
          (candidate) => specifier === candidate.name || specifier.startsWith(candidate.name + '/'),
        );
      if (!target || target === workspace) return;
      if (clientOnly.has(workspace.directory) && !clientOnly.has(target.directory))
        errors.push(file + ': client imports server workspace ' + target.name);
      if (!workspace.dependencies?.[target.name] && !workspace.devDependencies?.[target.name])
        errors.push(file + ': undeclared workspace dependency ' + target.name);
    }
    visit(source);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('[boundaries] Workspace dependencies and client/server boundaries passed');
