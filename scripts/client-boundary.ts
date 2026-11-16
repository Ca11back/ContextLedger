import { readFileSync } from 'node:fs';
import type { Rspack } from '@rsbuild/core';

interface ModuleNode {
  name?: string;
  identifier?: string;
  modules?: ModuleNode[];
  filteredModules?: number;
  filteredChildren?: number;
}
export function assertClientModules(modules: ModuleNode[]): number {
  let count = 0;
  for (const module of modules) {
    for (const identity of [module.name, module.identifier]) {
      const name = (identity ?? '').replaceAll('\\', '/');
      if (
        /(?:^|\/)src\/server\/|\.server\.[cm]?[jt]sx?(?:\?|$)|(?:^|[\s"'])bun:sqlite|(?:^|[\s"'])node:(?:fs|child_process|sqlite)/.test(
          name,
        )
      )
        throw new Error(`Server module in emitted client graph: ${name}`);
    }
    count++;
    if (module.filteredModules || module.filteredChildren)
      throw new Error('Client graph unexpectedly omitted modules');
    if (module.modules) count += assertClientModules(module.modules);
  }
  return count;
}

// Inspect Rspack's actual emitted client modules, after Start has stripped server handlers.
export class ClientBoundaryPlugin {
  apply(compiler: Rspack.Compiler) {
    compiler.hooks.done.tapPromise('ContextLedgerClientBoundary', async (stats) => {
      if (stats.hasErrors()) return;
      const graph = stats.toJson({
        all: false,
        modules: true,
        nestedModules: true,
        source: false,
        orphanModules: true,
        runtimeModules: true,
        groupModulesByType: false,
        groupModulesByCacheStatus: false,
        groupModulesByLayer: false,
        groupModulesByAttributes: false,
        groupModulesByPath: false,
        groupModulesByExtension: false,
        modulesSpace: Number.POSITIVE_INFINITY,
        nestedModulesSpace: Number.POSITIVE_INFINITY,
      });
      if (graph.filteredModules) throw new Error('Client graph unexpectedly omitted modules');
      const modules = graph.modules as ModuleNode[] | undefined;
      if (!modules?.length) throw new Error('Client compilation module graph is empty');
      const count = assertClientModules(modules);
      const fs = compiler.outputFileSystem;
      if (!fs) throw new Error('Client output filesystem unavailable');
      await new Promise<void>((resolve, reject) =>
        fs.writeFile(
          `${compiler.outputPath}/client-boundary.json`,
          JSON.stringify({ checkedModules: count, modules }),
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        ),
      );
    });
  }
}

if (import.meta.main) {
  const path = 'dist/client/client-boundary.json';
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    checkedModules: number;
    modules: ModuleNode[];
  };
  const checked = assertClientModules(report.modules);
  if (checked < 1 || checked !== report.checkedModules)
    throw new Error('Invalid client boundary report');
  console.log(`Client boundary verified: ${checked} compiled modules, no server imports.`);
}
