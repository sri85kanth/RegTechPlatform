"""
Risk assessment: risks derived from what we know about a company, scored by a
versioned rulebook, never by a model (scraper/docs/risk-module-design.md).

  predicates  structured conditions, evaluated three-valued (true / false / unknown)
  rulebook    load, merge, validate and hash-pin the YAML rulebooks in scraper/rulebooks
  engine      score one risk: inherent → residual → target, verdict, confidence, bounds
  library     risk templates bound to graph node types (library.yaml)
"""
