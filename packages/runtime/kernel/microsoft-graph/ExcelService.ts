import type { GraphClient } from "./GraphClient.js";
import { ok, fail, type ServiceContent } from "./service-result.js";

const enc = encodeURIComponent;

/**
 * Resolves the workbook drive-item prefix. Accepts either a drive item id
 * (`itemId`) or a path relative to the drive root (`itemPath`, e.g.
 * `Reports/Q3.xlsx`). Exactly one is required.
 */
const workbookBase = (args: { itemId?: string; itemPath?: string }): string => {
  if (args.itemId) {
    return `/me/drive/items/${enc(args.itemId)}/workbook`;
  }
  if (args.itemPath) {
    const clean = args.itemPath.replace(/^\/+/, "");
    return `/me/drive/root:/${clean.split("/").map(enc).join("/")}:/workbook`;
  }
  throw new Error("Provide either itemId or itemPath for the workbook.");
};

/**
 * Representative first-party Excel service over the Microsoft Graph workbook
 * API. Delegated `/me/drive` endpoints backed by the shared Microsoft grant's
 * `Files.ReadWrite` scope. Covers worksheet, range, and table reads/writes.
 */
export class ExcelService {
  constructor(private readonly graph: GraphClient) {}

  /** Lists the worksheets in a workbook. */
  public listWorksheets = async (args: {
    itemId?: string;
    itemPath?: string;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get<{ value?: unknown[] }>(
        `${workbookBase(args)}/worksheets`,
        { $select: "id,name,position,visibility" },
      );
      return ok({ worksheets: data.value ?? [] });
    } catch (error) {
      return fail("excel.listWorksheets", error);
    }
  };

  /** Reads a range's values/text/formulas, e.g. `A1:C10`. */
  public getRange = async (args: {
    itemId?: string;
    itemPath?: string;
    worksheet: string;
    address: string;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get<{
        address?: string;
        values?: unknown[][];
        text?: unknown[][];
      }>(
        `${workbookBase(args)}/worksheets/${enc(args.worksheet)}/range(address='${encodeURIComponent(args.address)}')`,
        { $select: "address,values,text,formulas" },
      );
      return ok({
        address: data.address,
        values: data.values ?? [],
        text: data.text ?? [],
      });
    } catch (error) {
      return fail("excel.getRange", error);
    }
  };

  /** Writes a 2D array of values into a range, overwriting existing cells. */
  public updateRange = async (args: {
    itemId?: string;
    itemPath?: string;
    worksheet: string;
    address: string;
    values: unknown[][];
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.patch<{
        address?: string;
        rowCount?: number;
        columnCount?: number;
      }>(
        `${workbookBase(args)}/worksheets/${enc(args.worksheet)}/range(address='${encodeURIComponent(args.address)}')`,
        { values: args.values },
      );
      return ok({
        address: data.address,
        rowCount: data.rowCount,
        columnCount: data.columnCount,
      });
    } catch (error) {
      return fail("excel.updateRange", error);
    }
  };

  /** Lists the tables defined in a workbook. */
  public listTables = async (args: {
    itemId?: string;
    itemPath?: string;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get<{ value?: unknown[] }>(
        `${workbookBase(args)}/tables`,
        { $select: "id,name,showHeaders,showTotals" },
      );
      return ok({ tables: data.value ?? [] });
    } catch (error) {
      return fail("excel.listTables", error);
    }
  };

  /** Appends one or more rows to a table by name or id. */
  public addTableRows = async (args: {
    itemId?: string;
    itemPath?: string;
    table: string;
    values: unknown[][];
    index?: number | null;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.post<{ index?: number }>(
        `${workbookBase(args)}/tables/${enc(args.table)}/rows/add`,
        {
          values: args.values,
          index: args.index ?? null,
        },
      );
      return ok({ index: data.index, addedRows: args.values.length });
    } catch (error) {
      return fail("excel.addTableRows", error);
    }
  };
}
