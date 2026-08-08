import { useMemo, useState, type ComponentType } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import type {
  MarkdownNode,
  NodeRendererProps,
} from "react-native-nitro-markdown";
import {
  estimateMarkdownTableColumnWidths,
  extractMarkdownTable,
  fitMarkdownTableColumnWidths,
} from "../lib/markdown-table-layout";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

type AssistantMarkdownTableProps = {
  node: MarkdownNode;
  Renderer: ComponentType<NodeRendererProps>;
  colors: Colors;
};

function TableCellContent({
  node,
  Renderer,
  textStyle,
}: {
  node?: MarkdownNode;
  Renderer: ComponentType<NodeRendererProps>;
  textStyle: StyleProp<TextStyle>;
}) {
  if (!node) return null;
  const children = node.children ?? [];

  return (
    <Text style={textStyle}>
      {children.length > 0
        ? children.map((child, index) => (
            <Renderer
              key={
                child.beg != null
                  ? `${child.type}-${child.beg}`
                  : `${child.type}-${index}`
              }
              node={child}
              depth={0}
              inListItem={false}
              parentIsText
            />
          ))
        : (node.content ?? "")}
    </Text>
  );
}

export function AssistantMarkdownTable({
  node,
  Renderer,
  colors,
}: AssistantMarkdownTableProps) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const data = useMemo(() => extractMarkdownTable(node), [node]);
  const estimatedWidths = useMemo(
    () => estimateMarkdownTableColumnWidths(data),
    [data],
  );
  const columnWidths = useMemo(
    () => fitMarkdownTableColumnWidths(estimatedWidths, viewportWidth),
    [estimatedWidths, viewportWidth],
  );
  const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0);

  if (data.headers.length === 0) return null;

  const cellAlignment = (columnIndex: number): TextStyle["textAlign"] => {
    const alignment = data.alignments[columnIndex];
    if (alignment === "center" || alignment === "right") return alignment;
    return "left";
  };

  return (
    <View
      style={styles.container}
      onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        bounces={false}
        alwaysBounceHorizontal={false}
        decelerationRate="normal"
        showsHorizontalScrollIndicator
        style={styles.scroller}
      >
        <View style={[styles.table, { width: tableWidth }]}>
          <View style={styles.headerRow}>
            {data.headers.map((cell, columnIndex) => (
              <View
                key={`header-${columnIndex}`}
                style={[
                  styles.cell,
                  styles.headerCell,
                  { width: columnWidths[columnIndex] },
                  columnIndex === data.headers.length - 1 && styles.lastCell,
                ]}
              >
                <TableCellContent
                  node={cell}
                  Renderer={Renderer}
                  textStyle={[
                    styles.headerText,
                    { textAlign: cellAlignment(columnIndex) },
                  ]}
                />
              </View>
            ))}
          </View>

          {data.rows.map((row, rowIndex) => (
            <View
              key={`row-${rowIndex}`}
              style={[
                styles.bodyRow,
                rowIndex % 2 === 0 ? styles.evenRow : styles.oddRow,
                rowIndex === data.rows.length - 1 && styles.lastRow,
              ]}
            >
              {data.headers.map((_, columnIndex) => (
                <View
                  key={`cell-${rowIndex}-${columnIndex}`}
                  style={[
                    styles.cell,
                    styles.bodyCell,
                    { width: columnWidths[columnIndex] },
                    columnIndex === data.headers.length - 1 && styles.lastCell,
                  ]}
                >
                  <TableCellContent
                    node={row[columnIndex]}
                    Renderer={Renderer}
                    textStyle={[
                      styles.bodyText,
                      { textAlign: cellAlignment(columnIndex) },
                    ]}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: {
      alignSelf: "stretch",
      marginVertical: 8,
      width: "100%",
    },
    scroller: {
      flexGrow: 0,
      width: "100%",
    },
    table: {
      borderColor: colors.border,
      borderRadius: 6,
      borderWidth: 1,
      overflow: "hidden",
    },
    headerRow: {
      backgroundColor: fadeHex(colors.muted, 0.4),
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
    },
    bodyRow: {
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
    },
    evenRow: {
      backgroundColor: "transparent",
    },
    oddRow: {
      backgroundColor: fadeHex(colors.muted, 0.2),
    },
    lastRow: {
      borderBottomWidth: 0,
    },
    cell: {
      borderRightColor: colors.border,
      borderRightWidth: 1,
      flexShrink: 0,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    headerCell: {
      justifyContent: "center",
    },
    bodyCell: {
      justifyContent: "center",
    },
    lastCell: {
      borderRightWidth: 0,
    },
    headerText: {
      color: colors.textStrong,
      fontFamily: fonts.sans.semiBold,
      fontSize: 12,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
    bodyText: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      ...(Platform.OS === "android" && { includeFontPadding: false }),
    },
  });
