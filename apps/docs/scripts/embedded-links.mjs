/** Prefix authored Markdown and MDX links; generated Starlight links use Astro.base. */
export function prefixDocsLinks() {
  return (tree) => {
    const prefix = (value) =>
      typeof value === 'string' &&
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !/^\/docs(?:\/|$|[?#])/.test(value)
        ? `/docs${value}`
        : value
    const visit = (node) => {
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') node.url = prefix(node.url)
      for (const attr of Array.isArray(node.attributes) ? node.attributes : []) {
        if (attr.type === 'mdxJsxAttribute' && ['href', 'src'].includes(attr.name)) attr.value = prefix(attr.value)
      }
      for (const child of Array.isArray(node.children) ? node.children : []) visit(child)
    }
    visit(tree)
  }
}
