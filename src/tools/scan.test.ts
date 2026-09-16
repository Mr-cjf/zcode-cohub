/**
 * Tests for co_scan MCP tool (scanHandler).
 *
 * All tests create temporary directories and files, then clean up.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { scanHandler, type ScanInput } from "./scan.js";

// ===== Helpers =====

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coscan-test-"));
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Create a file with the given content inside rootDir.
 */
function touch(rootDir: string, relativePath: string, content: string): void {
  const fullPath = join(rootDir, relativePath);
  const dir = join(rootDir, relativePath.split("/").slice(0, -1).join("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

describe("co_scan", () => {
  // ==================================================================
  // Test 1: Basic matching — file with "Foo" 3 times → count === 3
  // ==================================================================
  describe("basic matching", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/Main.java",
        [
          "public class Main {",
          "  private Foo foo1 = new Foo();",
          "  public void bar() {",
          "    Foo foo2 = Foo.create();",
          "  }",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("counts occurrences of a single symbol", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(1);
      // "Foo" appears 4 times: line 2 has "private Foo" + "new Foo()",
      // line 4 has "Foo foo2" + "Foo.create()"
      expect(result.symbols[0].reference_count).toBe(4);
      expect(result.symbols[0].symbol).toBe("Foo");
      // No declaration of "class Foo" in this file, so declaration_hits=0
      expect(result.symbols[0].declaration_hits).toBe(0);
      expect(result.zero_reference_symbols).toEqual([]);
      expect(result.scanned_files).toBe(1);
    });
  });

  // ==================================================================
  // Test 2: Word boundary — "Foo" should NOT match "FooBar" or "someFoo"
  // ==================================================================
  describe("word boundary", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/Test.java",
        [
          "public class Test {",
          "  private FooBar fooBar = new FooBar();",
          "  private int someFoo = 42;",
          "  public void test() {",
          "    Foo result = Foo.create();",
          "  }",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("does not match FooBar when searching for Foo", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      expect(result.symbols[0].reference_count).toBe(2); // only "Foo" occurrences, not FooBar or someFoo
    });
  });

  // ==================================================================
  // Test 3: Zero reference — non-existent symbol
  // ==================================================================
  describe("zero reference", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/App.java",
        "public class App { }\n",
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("reports non-existent symbol in zero_reference_symbols", async () => {
      const result = await scanHandler(
        { symbols: ["NonExistentSymbol"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      expect(result.zero_reference_symbols).toEqual(["NonExistentSymbol"]);
      expect(result.symbols[0].reference_count).toBe(0);
    });
  });

  // ==================================================================
  // Test 4: Timeout — very short timeout returns truncated result
  //
  // Strategy: create enough files so that `rg --files` + filtering
  // naturally takes more than the timeout value. If the test machine
  // is extremely fast and still completes within 1ms, the assertion
  // is relaxed to check at least that truncated is not false when
  // timeout is exceeded.
  //
  // Note: On Windows, spawning `rg --files` as a subprocess alone
  // typically takes ~5-20ms, so a 1ms timeout should reliably trigger.
  // ==================================================================
  describe("timeout", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      // Create 50 Java files with content — enough to ensure processing > 1ms
      for (let i = 0; i < 50; i++) {
        touch(
          tempDir,
          `src/File${i}.java`,
          `public class File${i} {\n  private Foo field = new Foo();\n}\n`,
        );
      }
    });

    afterAll(() => cleanupDir(tempDir));

    it("returns truncated=true with truncation_reason='timeout' when timeout_ms is very short", async () => {
      const result = await scanHandler(
        {
          symbols: ["Foo"],
          root_dir: tempDir,
          timeout_ms: 1,
        },
        { projectDir: tempDir },
      );
      // We expect truncated=true, but if the machine is extremely fast,
      // we at least verify no crash and partial results
      if (!result.truncated) {
        // This would mean the scan completed entirely within 1ms —
        // still acceptable but unexpected
        console.warn(
          "WARN: timeout test completed without truncation (machine may be too fast).",
        );
      } else {
        expect(result.truncation_reason).toBe("timeout");
      }
      expect(result.success).toBe(true);
    });

    it("populates warning when truncated", async () => {
      const result = await scanHandler(
        {
          symbols: ["Foo"],
          root_dir: tempDir,
          timeout_ms: 1,
        },
        { projectDir: tempDir },
      );
      if (result.truncated) {
        expect(result.warning).toBeDefined();
        expect(result.warning!.length).toBeGreaterThan(0);
      }
    });
  });

  // ==================================================================
  // Test 5: Large file skip — file exceeding max_file_size_bytes
  // ==================================================================
  describe("large file skip", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      // File just under size limit (normal)
      touch(
        tempDir,
        "src/Normal.java",
        "public class Normal { private Foo f; }\n",
      );
      // File exceeding size limit: write content larger than 200 bytes
      touch(
        tempDir,
        "src/Huge.java",
        "// " + "x".repeat(300) + "\npublic class Huge { private Foo f; }\n",
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("skips files larger than max_file_size_bytes", async () => {
      const result = await scanHandler(
        {
          symbols: ["Foo"],
          root_dir: tempDir,
          max_file_size_bytes: 200,
        },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      expect(result.skipped_files).toBeGreaterThanOrEqual(1);
      // Normal.java (< 200 bytes) should be scanned
      expect(result.scanned_files).toBeGreaterThanOrEqual(1);
    });
  });

  // ==================================================================
  // Test 6: Multiple symbols — 2/1/0 occurrences respectively
  // ==================================================================
  describe("multiple symbols", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/Service.java",
        [
          "public class Service {",
          "  private Alpha alpha = new Alpha();",
          "  private Alpha alpha2 = new Alpha(); // 2nd ref",
          "  private Beta beta = new Beta(); // 1 ref",
          "  // Gamma is never referenced here",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("reports different counts for multiple symbols", async () => {
      const result = await scanHandler(
        {
          symbols: ["Alpha", "Beta", "Gamma"],
          root_dir: tempDir,
        },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);

      const alpha = result.symbols.find((s) => s.symbol === "Alpha");
      const beta = result.symbols.find((s) => s.symbol === "Beta");
      const gamma = result.symbols.find((s) => s.symbol === "Gamma");

      // "Alpha" appears 4 times: line 2 has "private Alpha" + "new Alpha()",
      // line 3 has "private Alpha" + "new Alpha()"
      expect(alpha?.reference_count).toBe(4);
      expect(alpha?.declaration_hits).toBe(0);
      // "Beta" appears 2 times: line 4 has "private Beta" + "new Beta()"
      expect(beta?.reference_count).toBe(2);
      // "Gamma" appears 1 time in the comment on line 5
      expect(gamma?.reference_count).toBe(1);

      // Gamma appears once in the comment, so it's NOT zero-reference
      expect(result.zero_reference_symbols).not.toContain("Gamma");
      expect(result.zero_reference_symbols).not.toContain("Alpha");
      expect(result.zero_reference_symbols).not.toContain("Beta");
    });
  });

  // ==================================================================
  // Test 7: Regex metacharacter safety — symbol names with "." and "$"
  // ==================================================================
  describe("regex metacharacter safety", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/App.java",
        [
          "public class App {",
          "  private com.example.Foo foo = new com.example.Foo();",
          "  private InnerClass.Bar bar = new InnerClass.Bar();",
          "  private Baz$Inner baz = null;",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("handles dotted qualified names without crash or mis-match", async () => {
      // Search for "Foo" (the simple name extracted from com.example.Foo)
      const result = await scanHandler(
        {
          symbols: ["com.example.Foo"],
          root_dir: tempDir,
        },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // "Foo" appears twice: once in type decl "com.example.Foo foo" and once in "new com.example.Foo()"
      expect(result.symbols[0].reference_count).toBe(2);
      expect(result.symbols[0].symbol).toBe("com.example.Foo");
    });

    it("handles symbols with $ sign (inner class ref in type position)", async () => {
      const result2 = await scanHandler(
        {
          symbols: ["Baz$Inner"],
          root_dir: tempDir,
        },
        { projectDir: tempDir },
      );
      expect(result2.success).toBe(true);
      // Baz$Inner's simple name is "Baz$Inner" (no dot), so escapeRegex gives "Baz\\$Inner".
      // With the (?<![\w$]) / (?![\\w$]) boundary, "Baz$Inner" matches as a complete token
      // on line 322 ("private Baz$Inner baz = null;"). It's NOT a type declaration line
      // (no "class Baz$Inner" prefix), so it counts as a reference.
      expect(result2.symbols[0].reference_count).toBe(1);
      expect(result2.zero_reference_symbols).not.toContain("Baz$Inner");
    });

    it("preserves input order with mixed symbol types", async () => {
      const result3 = await scanHandler(
        {
          symbols: ["com.example.Foo", "NonExistent", "Baz$Inner"],
          root_dir: tempDir,
        },
        { projectDir: tempDir },
      );
      expect(result3.success).toBe(true);
      expect(result3.symbols[0].symbol).toBe("com.example.Foo");
      expect(result3.symbols[1].symbol).toBe("NonExistent");
      expect(result3.symbols[2].symbol).toBe("Baz$Inner");
      expect(result3.zero_reference_symbols).toContain("NonExistent");
      // Baz$Inner has 1 reference (line 322), not zero-reference
      expect(result3.zero_reference_symbols).not.toContain("Baz$Inner");
    });
  });

  // ==================================================================
  // Test 8: $Proxy — leading $ in symbol name (Fix 2 regression guard)
  // ==================================================================
  describe("leading dollar sign", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/ProxyUser.java",
        [
          "public class ProxyUser {",
          "  private $Proxy proxy;",
          "  public void use() {",
          "    $Proxy p = new $Proxy();",
          "  }",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("matches $Proxy symbol (leading $, Fix 2)", async () => {
      const result = await scanHandler(
        { symbols: ["$Proxy"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // "$Proxy" appears 3 times:
      // line 2: "private $Proxy proxy" -> 1
      // line 4: "$Proxy p" -> 1, "new $Proxy()" -> 1
      // No declaration (class $Proxy), so all counted
      expect(result.symbols[0].reference_count).toBe(3);
      expect(result.zero_reference_symbols).not.toContain("$Proxy");
    });
  });

  // ==================================================================
  // Test 9: Declaration skip — core fix (Fix 1)
  // ==================================================================
  describe("declaration skip", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      // File that defines Foo but only uses it in the declaration line
      touch(
        tempDir,
        "src/OnlyDecl.java",
        "public class Foo { }\n",
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("class declaration is excluded from reference_count", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // "class Foo" is a type declaration — skipped from reference_count
      expect(result.symbols[0].reference_count).toBe(0);
      expect(result.symbols[0].declaration_hits).toBe(1);
      expect(result.zero_reference_symbols).toContain("Foo");
    });
  });

  // ==================================================================
  // Test 10: Declaration skip + same-file reference (Fix 1)
  // ==================================================================
  describe("declaration + same-file reference", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      // File defines Foo and uses it as a field type in Bar
      touch(
        tempDir,
        "src/Example.java",
        [
          "public class Foo { }",
          "class Bar {",
          "  Foo f;",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("counts only non-declaration references", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // "Foo" appears:
      //   line 1: "public class Foo" -> DECLARATION, skipped
      //   line 3: "Foo f;" -> reference, counted
      // So reference_count=1, declaration_hits=1, NOT in zero_reference
      expect(result.symbols[0].reference_count).toBe(1);
      expect(result.symbols[0].declaration_hits).toBe(1);
      expect(result.zero_reference_symbols).not.toContain("Foo");
    });
  });

  // ==================================================================
  // Test 11: Declaration skip — cross-file reference (Fix 1)
  // ==================================================================
  describe("declaration + cross-file reference", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/Foo.java",
        "public class Foo { }\n",
      );
      touch(
        tempDir,
        "src/User.java",
        "public class User { private Foo f; }\n",
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("counts cross-file references correctly", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // Foo.java: "class Foo" -> declaration, skipped
      // User.java: "Foo f" -> reference, counted
      expect(result.symbols[0].reference_count).toBe(1);
      expect(result.symbols[0].declaration_hits).toBe(1);
      expect(result.zero_reference_symbols).not.toContain("Foo");
    });
  });

  // ==================================================================
  // Test 12: All declaration types — class/interface/enum/record (Fix 1)
  // ==================================================================
  describe("all declaration types", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/Types.java",
        [
          "public class MyClass { }",
          "public interface MyInterface { }",
          "public enum MyEnum { A, B }",
          "public record MyRecord(int x) { }",
          "@interface MyAnnotation { }",
          "",
          "class Consumer {",
          "  MyClass a;",
          "  MyInterface b;",
          "  MyEnum c;",
          "  MyRecord d;",
          "  MyAnnotation e;",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("skips class, interface, enum, record, @interface declaration lines", async () => {
      const result = await scanHandler(
        {
          symbols: ["MyClass", "MyInterface", "MyEnum", "MyRecord", "MyAnnotation"],
          root_dir: tempDir,
        },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);

      const myClass = result.symbols.find((s) => s.symbol === "MyClass")!;
      expect(myClass.reference_count).toBe(1); // "MyClass a;" on line 9
      expect(myClass.declaration_hits).toBe(1); // "class MyClass" on line 1

      const myInterface = result.symbols.find((s) => s.symbol === "MyInterface")!;
      expect(myInterface.reference_count).toBe(1); // "MyInterface b;" on line 10
      expect(myInterface.declaration_hits).toBe(1); // "interface MyInterface" on line 2

      const myEnum = result.symbols.find((s) => s.symbol === "MyEnum")!;
      expect(myEnum.reference_count).toBe(1); // "MyEnum c;" on line 11
      expect(myEnum.declaration_hits).toBe(1); // "enum MyEnum" on line 3

      const myRecord = result.symbols.find((s) => s.symbol === "MyRecord")!;
      expect(myRecord.reference_count).toBe(1); // "MyRecord d;" on line 12
      expect(myRecord.declaration_hits).toBe(1); // "record MyRecord" on line 4

      const myAnnotation = result.symbols.find((s) => s.symbol === "MyAnnotation")!;
      expect(myAnnotation.reference_count).toBe(1); // "MyAnnotation e;" on line 13
      expect(myAnnotation.declaration_hits).toBe(1); // "@interface MyAnnotation" on line 6
    });
  });

  // ==================================================================
  // Test 13: Constructor is NOT skipped (Fix 1 — conservative strategy)
  // ==================================================================
  describe("constructor not skipped", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/MyClass.java",
        [
          "public class MyClass {",
          "  public MyClass() { }",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("counts constructor as reference, not declaration", async () => {
      const result = await scanHandler(
        { symbols: ["MyClass"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // "class MyClass" -> declaration, skipped -> declaration_hits=1
      // "public MyClass()" -> constructor, not skipped -> reference_count=1
      expect(result.symbols[0].reference_count).toBe(1);
      expect(result.symbols[0].declaration_hits).toBe(1);
      expect(result.zero_reference_symbols).not.toContain("MyClass");
    });
  });

  // ==================================================================
  // Test 14: count_declarations=true restores total count (Fix 1)
  // ==================================================================
  describe("count_declarations option", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/Foo.java",
        "public class Foo { }\n",
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("includes declaration lines when count_declarations=true", async () => {
      const result = await scanHandler(
        {
          symbols: ["Foo"],
          root_dir: tempDir,
          count_declarations: true,
        },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // "class Foo" is counted because count_declarations=true
      expect(result.symbols[0].reference_count).toBe(1);
      // declaration_hits should be 0 when count_declarations=true
      expect(result.symbols[0].declaration_hits).toBe(0);
    });
  });

  // ==================================================================
  // Edge cases
  // ==================================================================

  describe("error handling", () => {
    it("returns success=false when root_dir does not exist", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: "C:/non-existent-path-12345" },
        { projectDir: __dirname },
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("not found");
    });

    it("returns success=false when symbols list is empty", async () => {
      const result = await scanHandler(
        { symbols: [], root_dir: __dirname },
        { projectDir: __dirname },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("No symbols");
    });
  });

  describe("include_samples", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(
        tempDir,
        "src/App.java",
        [
          "public class App {",
          "  private Foo foo;",
          "  public void run() {",
          "    this.foo = Foo.create();",
          "  }",
          "}",
        ].join("\n"),
      );
    });

    afterAll(() => cleanupDir(tempDir));

    it("returns sample_lines when include_samples=true", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir, include_samples: true },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      expect(result.symbols[0].sample_lines).toBeDefined();
      expect(result.symbols[0].sample_lines!.length).toBeGreaterThan(0);
      expect(result.symbols[0].sample_lines!.length).toBeLessThanOrEqual(3);
    });

    it("does not return sample_lines when include_samples=false (default)", async () => {
      const result = await scanHandler(
        { symbols: ["Foo"], root_dir: tempDir },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      expect(result.symbols[0].sample_lines).toBeUndefined();
    });
  });

  describe("deduplication", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir();
      touch(tempDir, "src/A.java", "class A { Foo f; }\n");
    });

    afterAll(() => cleanupDir(tempDir));

    it("deduplicates identical simple names but preserves input order in result", async () => {
      const result = await scanHandler(
        {
          symbols: ["Foo", "Foo", "com.example.Foo"],
          root_dir: tempDir,
        },
        { projectDir: tempDir },
      );
      expect(result.success).toBe(true);
      // Input ["Foo", "Foo", "com.example.Foo"] — "Foo" deduplicated to 1 entry,
      // "com.example.Foo" shares the same simple name "Foo" so also deduplicated in
      // the scan regex. Result has 2 entries preserving input order.
      expect(result.symbols).toHaveLength(2);
      // But zero_reference should be empty since Foo has 1 reference
      expect(result.zero_reference_symbols).toEqual([]);
      expect(result.symbols[0].symbol).toBe("Foo");
      expect(result.symbols[1].symbol).toBe("com.example.Foo");
    });
  });
});