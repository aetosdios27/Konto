import { describe, it, expect } from "vitest";
import { buildQuery as vercelBuildQuery } from "../src/vercel";
import { buildQuery as neonBuildQuery } from "../src/neon";

describe("Tagged Template Stitching", () => {
  const adapters = [
    { name: "Vercel", buildQuery: vercelBuildQuery },
    { name: "Neon", buildQuery: neonBuildQuery }
  ];

  for (const adapter of adapters) {
    describe(`${adapter.name} Adapter`, () => {
      
      it("should handle single interpolated value", () => {
        const id = 123;
        const fakeSql = (strings: TemplateStringsArray, ...values: any[]) => adapter.buildQuery(strings, values);
        
        const result = fakeSql`SELECT * FROM t WHERE id = ${id}`;
        
        expect(result.text).toBe("SELECT * FROM t WHERE id = $1");
        expect(result.params).toEqual([id]);
      });

      it("should handle multiple interpolated values", () => {
        const a = "hello";
        const b = "world";
        const fakeSql = (strings: TemplateStringsArray, ...values: any[]) => adapter.buildQuery(strings, values);
        
        const result = fakeSql`INSERT INTO t VALUES (${a}, ${b})`;
        
        expect(result.text).toBe("INSERT INTO t VALUES ($1, $2)");
        expect(result.params).toEqual([a, b]);
      });

      it("should convert bigint to string to prevent JSON serialization errors", () => {
        const amount = 5000n;
        const fakeSql = (strings: TemplateStringsArray, ...values: any[]) => adapter.buildQuery(strings, values);
        
        const result = fakeSql`WHERE amount = ${amount}`;
        
        expect(result.text).toBe("WHERE amount = $1");
        expect(result.params).toEqual(["5000"]);
      });

      it("should pass null through unmodified", () => {
        const value = null;
        const fakeSql = (strings: TemplateStringsArray, ...values: any[]) => adapter.buildQuery(strings, values);
        
        const result = fakeSql`WHERE x = ${value}`;
        
        expect(result.text).toBe("WHERE x = $1");
        expect(result.params).toEqual([null]);
      });

      it("should pass arrays through unmodified", () => {
        const ids = ["uuid1", "uuid2"];
        const fakeSql = (strings: TemplateStringsArray, ...values: any[]) => adapter.buildQuery(strings, values);
        
        const result = fakeSql`WHERE id = ANY(${ids}::uuid[])`;
        
        expect(result.text).toBe("WHERE id = ANY($1::uuid[])");
        expect(result.params).toEqual([ids]);
      });
      
    });
  }
});
