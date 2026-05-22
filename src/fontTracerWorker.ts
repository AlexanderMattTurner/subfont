/**
 * Piscina worker handler for parallel fontTracer execution.
 *
 * Receives:  { htmlText, stylesheetsWithPredicates }
 * Returns:   Array<{ text, props }>
 *
 * Re-parses HTML with jsdom inside the worker since DOM objects
 * cannot be transferred via structured clone.
 */

import { JSDOM } from 'jsdom';
import * as postcss from 'postcss';
import memoizeSync = require('memoizesync');
import fontTracer = require('font-tracer');
import getCssRulesByProperty = require('./getCssRulesByProperty');

interface SerializedStylesheet {
  text: string;
  // Predicates carry CSS-tracing context (mediaQuery, script/scope flags).
  // Their value union is wider than booleans alone.
  predicates: Record<string, unknown>; // eslint-disable-line no-restricted-syntax
}

interface TraceTask {
  htmlText: string;
  stylesheetsWithPredicates: SerializedStylesheet[];
}

interface TextByPropsEntry {
  text: string;
  // The trace result shape is defined by font-tracer; we forward it
  // through to the pool caller unchanged.
  props: Record<string, unknown>; // eslint-disable-line no-restricted-syntax
}

// Each worker gets its own memoized getCssRulesByProperty instance.
// Pages on the same site typically share stylesheets, so memoization
// is effective even within a single worker processing multiple pages.
const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);

function trace(task: TraceTask): TextByPropsEntry[] {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(task.htmlText);
    const document = dom.window.document;

    // Re-parse CSS from serialized text — asset objects with PostCSS
    // trees can't cross the structured clone boundary.
    const stylesheetsWithPredicates = task.stylesheetsWithPredicates.map(
      (entry) => ({
        asset: { parseTree: postcss.parse(entry.text) },
        text: entry.text,
        predicates: entry.predicates,
      })
    );

    const textByProps = fontTracer(document, {
      stylesheetsWithPredicates,
      getCssRulesByProperty: memoizedGetCssRulesByProperty,
    });

    // Strip any non-serializable data from results.
    return textByProps.map((entry) => ({
      text: entry.text,
      props: { ...entry.props },
    }));
  } finally {
    if (dom) dom.window.close();
  }
}

export = trace;
