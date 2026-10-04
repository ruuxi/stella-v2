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
import { SelectableMarkdownText, nativeMarkdownSelectionAvailable } from "./SelectableMarkdownText";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

type AssistantMarkdownTableProps = {
  node: MarkdownNode;
  Renderer: ComponentType<NodeRendererProps>;
  colors: Colors;
  selectable?: boolean;
  onLinkPress?: (url: string) => unknown;
  onAskStella?: (text: string) => void;
};

function TableCellContent({
  node,
  Renderer,
  textStyle,
  selectable,
  colors,
  onLinkPress,
  onAskStella,
}: {
  colors: Colors;
  node?: MarkdownNode;
  Renderer: ComponentType<NodeRendererProps>;
  textStyle: StyleProp<TextStyle>;
  selectable?: boolean;
  onLinkPress?: (url: string) => unknown;
  onAskStella?: (text: string) => void;
}) {
  if (!node) return null;
  if (selectable && nativeMarkdownSelectionAvailable) return <SelectableMarkdownText onAskStella={onAskStella} node={node} colors={colors} textStyle={textStyle} onLinkPress={onLinkPress} />;
  const children = node.children ?? [];

  return (
    <Text style={textStyle} selectable={selectable}>
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
  selectable,
  onLinkPress,
  onAskStella,
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
        <View style={{ width: tableWidth }}>
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
                  selectable={selectable}
                  colors={colors}
                  onLinkPress={onLinkPress}
                  onAskStella={onAskStella}
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
              style={[styles.bodyRow, rowIndex === 0 && styles.firstBodyRow]}
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
                    selectable={selectable}
                    colors={colors}
                    onLinkPress={onLinkPress}
                    onAskStella={onAskStella}
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

// An open, rule-divided table matching desktop: no frame, fills or column
// dividers; a firm rule under the header and hairlines between rows, with the
// first column flush to the prose. Cell padding still totals 24pt so
// `estimateMarkdownTableColumnWidths` stays accurate.
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
    headerRow: {
      borderBottomColor: fadeHex(colors.text, 0.32),
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: "row",
    },
    bodyRow: {
      borderTopColor: fadeHex(colors.text, 0.12),
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
    },
    firstBodyRow: {
      borderTopWidth: 0,
    },
    cell: {
      flexShrink: 0,
      paddingLeft: 0,
      paddingRight: 24,
      paddingVertical: 10,
    },
    headerCell: {
      justifyContent: "flex-end",
      paddingBottom: 8,
    },
    bodyCell: {
      justifyContent: "flex-start",
    },
    lastCell: {
      paddingRight: 0,
    },
    headerText: {
      color: colors.textStrong,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      lineHeight: 20,
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
