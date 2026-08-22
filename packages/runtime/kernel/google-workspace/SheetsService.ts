/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, sheets_v4 } from "googleapis";
import { AuthManager } from "./AuthManager.js";
import { logToFile } from "./logger.js";
import { createGoogleClientOptions } from "./GaxiosConfig.js";

type ValueInputOption = "RAW" | "USER_ENTERED";

const SPREADSHEET_URL_PATTERN = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

/** Accepts a raw spreadsheet id or a full Google Sheets URL. */
const extractSpreadsheetId = (idOrUrl: string): string => {
  const match = idOrUrl.match(SPREADSHEET_URL_PATTERN);
  return match?.[1] ?? idOrUrl.trim();
};

const normalizeValueInputOption = (value: unknown): ValueInputOption =>
  value === "RAW" ? "RAW" : "USER_ENTERED";

/**
 * Minimal, write-capable Google Sheets service backing the Workspace
 * demo. Uses the shared Google grant's `spreadsheets` scope for create,
 * read, write, append, and tab operations.
 */
export class SheetsService {
  constructor(private authManager: AuthManager) {}

  private async getSheetsClient(): Promise<sheets_v4.Sheets> {
    const auth = await this.authManager.getAuthenticatedClient();
    return google.sheets({
      version: "v4",
      ...createGoogleClientOptions(auth),
    });
  }

  private ok(payload: unknown) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  private handleError(
    context: string,
    error: unknown,
  ): {
    isError: true;
    content: { type: "text"; text: string }[];
  } {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logToFile(`Error during ${context}: ${errorMessage}`);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
    };
  }

  /** Creates a new spreadsheet, optionally with named tabs. */
  public create = async ({
    title,
    sheetTitles,
  }: {
    title: string;
    sheetTitles?: string[];
  }) => {
    logToFile(`[SheetsService] Creating spreadsheet: ${title}`);
    try {
      const sheets = await this.getSheetsClient();
      const requestBody: sheets_v4.Schema$Spreadsheet = {
        properties: { title },
      };
      if (Array.isArray(sheetTitles) && sheetTitles.length > 0) {
        requestBody.sheets = sheetTitles.map((sheetTitle) => ({
          properties: { title: String(sheetTitle) },
        }));
      }
      const res = await sheets.spreadsheets.create({
        requestBody,
        fields: "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties",
      });
      return this.ok({
        spreadsheetId: res.data.spreadsheetId,
        spreadsheetUrl: res.data.spreadsheetUrl,
        title: res.data.properties?.title,
        sheets: (res.data.sheets ?? []).map((sheet) => ({
          sheetId: sheet.properties?.sheetId,
          title: sheet.properties?.title,
        })),
      });
    } catch (error) {
      return this.handleError("sheets.create", error);
    }
  };

  /** Returns spreadsheet metadata (title + tabs). */
  public getSpreadsheet = async ({
    spreadsheetId,
  }: {
    spreadsheetId: string;
  }) => {
    try {
      const sheets = await this.getSheetsClient();
      const id = extractSpreadsheetId(spreadsheetId);
      const res = await sheets.spreadsheets.get({
        spreadsheetId: id,
        fields: "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties",
      });
      return this.ok({
        spreadsheetId: res.data.spreadsheetId,
        spreadsheetUrl: res.data.spreadsheetUrl,
        title: res.data.properties?.title,
        sheets: (res.data.sheets ?? []).map((sheet) => ({
          sheetId: sheet.properties?.sheetId,
          title: sheet.properties?.title,
          gridProperties: sheet.properties?.gridProperties,
        })),
      });
    } catch (error) {
      return this.handleError("sheets.getSpreadsheet", error);
    }
  };

  /** Reads a range of values, e.g. `Sheet1!A1:C10`. */
  public getValues = async ({
    spreadsheetId,
    range,
  }: {
    spreadsheetId: string;
    range: string;
  }) => {
    try {
      const sheets = await this.getSheetsClient();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: extractSpreadsheetId(spreadsheetId),
        range,
      });
      return this.ok({
        range: res.data.range,
        values: res.data.values ?? [],
      });
    } catch (error) {
      return this.handleError("sheets.getValues", error);
    }
  };

  /** Writes values to a range, overwriting existing cells. */
  public updateValues = async ({
    spreadsheetId,
    range,
    values,
    valueInputOption,
  }: {
    spreadsheetId: string;
    range: string;
    values: unknown[][];
    valueInputOption?: ValueInputOption;
  }) => {
    try {
      const sheets = await this.getSheetsClient();
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId: extractSpreadsheetId(spreadsheetId),
        range,
        valueInputOption: normalizeValueInputOption(valueInputOption),
        requestBody: { values: values as unknown[][] },
      });
      return this.ok({
        spreadsheetId: res.data.spreadsheetId,
        updatedRange: res.data.updatedRange,
        updatedRows: res.data.updatedRows,
        updatedColumns: res.data.updatedColumns,
        updatedCells: res.data.updatedCells,
      });
    } catch (error) {
      return this.handleError("sheets.updateValues", error);
    }
  };

  /** Appends rows after the last row of data in a range. */
  public appendValues = async ({
    spreadsheetId,
    range,
    values,
    valueInputOption,
  }: {
    spreadsheetId: string;
    range: string;
    values: unknown[][];
    valueInputOption?: ValueInputOption;
  }) => {
    try {
      const sheets = await this.getSheetsClient();
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: extractSpreadsheetId(spreadsheetId),
        range,
        valueInputOption: normalizeValueInputOption(valueInputOption),
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: values as unknown[][] },
      });
      return this.ok({
        spreadsheetId: res.data.spreadsheetId,
        tableRange: res.data.tableRange,
        updatedRange: res.data.updates?.updatedRange,
        updatedRows: res.data.updates?.updatedRows,
        updatedCells: res.data.updates?.updatedCells,
      });
    } catch (error) {
      return this.handleError("sheets.appendValues", error);
    }
  };

  /** Adds a new tab (sheet) to an existing spreadsheet. */
  public addSheet = async ({
    spreadsheetId,
    title,
  }: {
    spreadsheetId: string;
    title: string;
  }) => {
    try {
      const sheets = await this.getSheetsClient();
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: extractSpreadsheetId(spreadsheetId),
        requestBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
      const added = res.data.replies?.[0]?.addSheet?.properties;
      return this.ok({
        spreadsheetId: res.data.spreadsheetId,
        addedSheet: added
          ? { sheetId: added.sheetId, title: added.title }
          : null,
      });
    } catch (error) {
      return this.handleError("sheets.addSheet", error);
    }
  };
}
