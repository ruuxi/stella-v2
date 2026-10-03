/*
 * A small JSON reader and string escaper shared by the Windows and Linux
 * launchers. They only read short documents (channel messages from Electron,
 * the app-source bootstrap response, launcher.json, launcher-state.json), so
 * this favors being small and dependency-free over speed. Header-only; every
 * function is static. Compiles as C99 and C++.
 */
#ifndef STELLA_MINI_JSON_H
#define STELLA_MINI_JSON_H

#include <stdlib.h>
#include <string.h>

typedef enum { MJ_NULL, MJ_BOOL, MJ_NUMBER, MJ_STRING, MJ_ARRAY, MJ_OBJECT } mj_type;

typedef struct mj_value {
    mj_type type;
    int boolean;
    double number;
    char *string;            /* MJ_STRING, UTF-8, NUL-terminated */
    size_t count;            /* MJ_ARRAY / MJ_OBJECT */
    struct mj_value *items;  /* count values */
    char **keys;             /* MJ_OBJECT: count keys */
} mj_value;

typedef struct {
    const char *p;
    const char *end;
    int depth;
} mj_parser;

static void mj_free_value(mj_value *v) {
    size_t i;
    if (!v) return;
    free(v->string);
    for (i = 0; i < v->count; i++) {
        mj_free_value(&v->items[i]);
        if (v->keys) free(v->keys[i]);
    }
    free(v->items);
    free(v->keys);
    memset(v, 0, sizeof(*v));
}

static void mj_free(mj_value *v) {
    if (!v) return;
    mj_free_value(v);
    free(v);
}

static void mj_skip_ws(mj_parser *ps) {
    while (ps->p < ps->end && (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r')) ps->p++;
}

static int mj_hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int mj_read_hex4(mj_parser *ps, unsigned *out) {
    unsigned v = 0;
    int i;
    if (ps->end - ps->p < 4) return 0;
    for (i = 0; i < 4; i++) {
        int h = mj_hex(ps->p[i]);
        if (h < 0) return 0;
        v = (v << 4) | (unsigned)h;
    }
    ps->p += 4;
    *out = v;
    return 1;
}

static size_t mj_put_utf8(char *dst, unsigned cp) {
    if (cp < 0x80) { dst[0] = (char)cp; return 1; }
    if (cp < 0x800) { dst[0] = (char)(0xC0 | (cp >> 6)); dst[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
    if (cp < 0x10000) {
        dst[0] = (char)(0xE0 | (cp >> 12)); dst[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        dst[2] = (char)(0x80 | (cp & 0x3F)); return 3;
    }
    dst[0] = (char)(0xF0 | (cp >> 18)); dst[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    dst[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); dst[3] = (char)(0x80 | (cp & 0x3F)); return 4;
}

static char *mj_parse_string_raw(mj_parser *ps) {
    /* ps->p is just past the opening quote. Output is never longer than input. */
    const char *start = ps->p;
    char *out = (char *)malloc((size_t)(ps->end - start) + 1);
    size_t n = 0;
    if (!out) return NULL;
    while (ps->p < ps->end) {
        char c = *ps->p++;
        if (c == '"') { out[n] = 0; return out; }
        if ((unsigned char)c < 0x20) break;
        if (c != '\\') { out[n++] = c; continue; }
        if (ps->p >= ps->end) break;
        c = *ps->p++;
        switch (c) {
        case '"': out[n++] = '"'; break;
        case '\\': out[n++] = '\\'; break;
        case '/': out[n++] = '/'; break;
        case 'b': out[n++] = '\b'; break;
        case 'f': out[n++] = '\f'; break;
        case 'n': out[n++] = '\n'; break;
        case 'r': out[n++] = '\r'; break;
        case 't': out[n++] = '\t'; break;
        case 'u': {
            unsigned cp, lo;
            if (!mj_read_hex4(ps, &cp)) goto fail;
            if (cp >= 0xD800 && cp <= 0xDBFF && ps->end - ps->p >= 6 && ps->p[0] == '\\' && ps->p[1] == 'u') {
                ps->p += 2;
                if (!mj_read_hex4(ps, &lo)) goto fail;
                if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                else cp = 0xFFFD;
            } else if (cp >= 0xD800 && cp <= 0xDFFF) {
                cp = 0xFFFD;
            }
            n += mj_put_utf8(out + n, cp);
            break;
        }
        default: goto fail;
        }
    }
fail:
    free(out);
    return NULL;
}

static int mj_parse_value(mj_parser *ps, mj_value *v);

static int mj_push(mj_value *container, mj_value *item, char *key) {
    mj_value *items = (mj_value *)realloc(container->items, (container->count + 1) * sizeof(mj_value));
    if (!items) return 0;
    container->items = items;
    if (container->type == MJ_OBJECT) {
        char **keys = (char **)realloc(container->keys, (container->count + 1) * sizeof(char *));
        if (!keys) return 0;
        container->keys = keys;
        container->keys[container->count] = key;
    }
    container->items[container->count++] = *item;
    return 1;
}

static int mj_parse_value(mj_parser *ps, mj_value *v) {
    memset(v, 0, sizeof(*v));
    mj_skip_ws(ps);
    if (ps->p >= ps->end) return 0;
    if (++ps->depth > 64) return 0;
    switch (*ps->p) {
    case '{':
    case '[': {
        char close = *ps->p == '{' ? '}' : ']';
        v->type = *ps->p == '{' ? MJ_OBJECT : MJ_ARRAY;
        ps->p++;
        mj_skip_ws(ps);
        if (ps->p < ps->end && *ps->p == close) { ps->p++; break; }
        for (;;) {
            char *key = NULL;
            mj_value item;
            mj_skip_ws(ps);
            if (v->type == MJ_OBJECT) {
                if (ps->p >= ps->end || *ps->p != '"') return 0;
                ps->p++;
                key = mj_parse_string_raw(ps);
                if (!key) return 0;
                mj_skip_ws(ps);
                if (ps->p >= ps->end || *ps->p != ':') { free(key); return 0; }
                ps->p++;
            }
            if (!mj_parse_value(ps, &item)) { free(key); mj_free_value(&item); return 0; }
            if (!mj_push(v, &item, key)) { free(key); mj_free_value(&item); return 0; }
            mj_skip_ws(ps);
            if (ps->p < ps->end && *ps->p == ',') { ps->p++; continue; }
            if (ps->p < ps->end && *ps->p == close) { ps->p++; break; }
            return 0;
        }
        break;
    }
    case '"':
        ps->p++;
        v->type = MJ_STRING;
        v->string = mj_parse_string_raw(ps);
        if (!v->string) return 0;
        break;
    case 't':
        if (ps->end - ps->p < 4 || strncmp(ps->p, "true", 4) != 0) return 0;
        ps->p += 4; v->type = MJ_BOOL; v->boolean = 1;
        break;
    case 'f':
        if (ps->end - ps->p < 5 || strncmp(ps->p, "false", 5) != 0) return 0;
        ps->p += 5; v->type = MJ_BOOL;
        break;
    case 'n':
        if (ps->end - ps->p < 4 || strncmp(ps->p, "null", 4) != 0) return 0;
        ps->p += 4; v->type = MJ_NULL;
        break;
    default: {
        char buf[64];
        size_t n = 0;
        while (ps->p < ps->end && n < sizeof(buf) - 1 && strchr("+-0123456789.eE", *ps->p)) buf[n++] = *ps->p++;
        if (n == 0) return 0;
        buf[n] = 0;
        v->type = MJ_NUMBER;
        v->number = strtod(buf, NULL);
        break;
    }
    }
    ps->depth--;
    return 1;
}

/* Parse a whole document; NULL when it isn't valid JSON. */
static mj_value *mj_parse(const char *text, size_t len) {
    mj_parser ps;
    mj_value *v = (mj_value *)calloc(1, sizeof(mj_value));
    if (!v || !text) { free(v); return NULL; }
    ps.p = text; ps.end = text + len; ps.depth = 0;
    if (!mj_parse_value(&ps, v)) { mj_free(v); return NULL; }
    mj_skip_ws(&ps);
    if (ps.p != ps.end) { mj_free(v); return NULL; }
    return v;
}

static const mj_value *mj_get(const mj_value *obj, const char *key) {
    size_t i;
    if (!obj || obj->type != MJ_OBJECT) return NULL;
    for (i = 0; i < obj->count; i++)
        if (strcmp(obj->keys[i], key) == 0) return &obj->items[i];
    return NULL;
}

static const char *mj_get_string(const mj_value *obj, const char *key) {
    const mj_value *v = mj_get(obj, key);
    return v && v->type == MJ_STRING ? v->string : NULL;
}

static int mj_get_number(const mj_value *obj, const char *key, double *out) {
    const mj_value *v = mj_get(obj, key);
    if (!v || v->type != MJ_NUMBER) return 0;
    *out = v->number;
    return 1;
}

/* A malloc'd JSON string literal (with quotes) for `s`. */
static char *mj_quote(const char *s) {
    size_t len = s ? strlen(s) : 0, i, n = 0;
    char *out = (char *)malloc(len * 6 + 3);
    static const char hex[] = "0123456789abcdef";
    if (!out) return NULL;
    out[n++] = '"';
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
        case '"': out[n++] = '\\'; out[n++] = '"'; break;
        case '\\': out[n++] = '\\'; out[n++] = '\\'; break;
        case '\n': out[n++] = '\\'; out[n++] = 'n'; break;
        case '\r': out[n++] = '\\'; out[n++] = 'r'; break;
        case '\t': out[n++] = '\\'; out[n++] = 't'; break;
        default:
            if (c < 0x20) {
                out[n++] = '\\'; out[n++] = 'u'; out[n++] = '0'; out[n++] = '0';
                out[n++] = hex[c >> 4]; out[n++] = hex[c & 15];
            } else {
                out[n++] = (char)c;
            }
        }
    }
    out[n++] = '"';
    out[n] = 0;
    return out;
}

#endif
