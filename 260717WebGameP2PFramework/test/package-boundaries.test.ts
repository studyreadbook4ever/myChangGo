import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const relayPlayImportPattern = /^@relayplay\/[a-z0-9-]+(?:\/.*)?$/u;
const importSpecifierPattern =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu;

interface BoundaryPolicy {
  readonly directory: string;
  readonly packageName: string;
  readonly allowedRelayPlayPackages: readonly string[];
}

const packagePolicies: readonly BoundaryPolicy[] = [
  {
    directory: "packages/core",
    packageName: "@relayplay/core",
    allowedRelayPlayPackages: [],
  },
  {
    directory: "packages/client",
    packageName: "@relayplay/client",
    allowedRelayPlayPackages: ["@relayplay/core"],
  },
  {
    directory: "packages/server",
    packageName: "@relayplay/server",
    allowedRelayPlayPackages: ["@relayplay/core"],
  },
  {
    directory: "packages/cloudflare",
    packageName: "@relayplay/cloudflare",
    allowedRelayPlayPackages: ["@relayplay/core", "@relayplay/server"],
  },
  {
    directory: "packages/node",
    packageName: "@relayplay/node",
    allowedRelayPlayPackages: ["@relayplay/core", "@relayplay/server"],
  },
];

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(importSpecifierPattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function relayPlayPackage(specifier: string): string | undefined {
  if (!relayPlayImportPattern.test(specifier)) return undefined;
  const [scope, name] = specifier.split("/");
  return scope === undefined || name === undefined ? undefined : `${scope}/${name}`;
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function disallowedRelayPlayImports(
  sourceRoot: string,
  allowedPackages: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    for (const specifier of importSpecifiers(file)) {
      const internalPackage = relayPlayPackage(specifier);
      if (internalPackage !== undefined && !allowedPackages.includes(internalPackage)) {
        violations.push(`${relative(repositoryRoot, file)} imports ${specifier}`);
      }
    }
  }
  return violations;
}

function packageJson(path: string): {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
  };
}

describe("non-monolithic package boundaries", () => {
  for (const policy of packagePolicies) {
    it(`${policy.packageName} only depends inward`, () => {
      const packageRoot = join(repositoryRoot, policy.directory);
      const sourceRoot = join(packageRoot, "src");
      const violations: string[] = [];
      const importedPackages = new Set<string>();

      for (const file of sourceFiles(sourceRoot)) {
        for (const specifier of importSpecifiers(file)) {
          const internalPackage = relayPlayPackage(specifier);
          if (internalPackage !== undefined) {
            importedPackages.add(internalPackage);
            if (!policy.allowedRelayPlayPackages.includes(internalPackage)) {
              violations.push(`${relative(repositoryRoot, file)} imports ${specifier}`);
            }
          }
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(file), specifier);
            if (!isInside(sourceRoot, target)) {
              violations.push(`${relative(repositoryRoot, file)} escapes with ${specifier}`);
            }
          }
        }
      }

      const manifest = packageJson(join(packageRoot, "package.json"));
      const declaredPackages = new Set(
        Object.keys({
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
        }).filter((name) => name.startsWith("@relayplay/")),
      );

      expect(violations).toEqual([]);
      expect([...declaredPackages].sort()).toEqual(
        [...policy.allowedRelayPlayPackages].sort(),
      );
      expect([...importedPackages].sort()).toEqual(
        [...policy.allowedRelayPlayPackages].sort(),
      );
    });
  }

  it("keeps the browser example free of server and provider adapters", () => {
    const browserRoot = join(repositoryRoot, "examples/live-race/src");
    const allowedPackages = ["@relayplay/client", "@relayplay/core"];
    const violations = disallowedRelayPlayImports(browserRoot, allowedPackages);

    for (const file of sourceFiles(browserRoot)) {
      for (const specifier of importSpecifiers(file)) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (!isInside(browserRoot, target)) {
            violations.push(`${relative(repositoryRoot, file)} escapes with ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  const examplePolicies = [
    {
      name: "shared game policy",
      directory: "examples/live-race/server",
      allowedPackages: ["@relayplay/core", "@relayplay/server"],
    },
    {
      name: "Node composition root",
      directory: "examples/live-race/node",
      allowedPackages: ["@relayplay/node"],
    },
    {
      name: "Cloudflare composition root",
      directory: "examples/live-race/worker",
      allowedPackages: ["@relayplay/cloudflare"],
    },
  ] as const;

  for (const policy of examplePolicies) {
    it(`keeps ${policy.name} provider-focused`, () => {
      expect(
        disallowedRelayPlayImports(
          join(repositoryRoot, policy.directory),
          policy.allowedPackages,
        ),
      ).toEqual([]);
    });
  }
});
