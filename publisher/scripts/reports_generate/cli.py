import argparse
from pathlib import Path
from dataset_cache import DatasetCache
from generate import generate
import reports

def main():
  parser = argparse.ArgumentParser(description="Puffin-Bench CLI")
  subparsers = parser.add_subparsers(dest="command", required=True)

  generate_parser = subparsers.add_parser("generate", help="Generate dataset CSV from run directories")
  generate_parser.add_argument("root_dir", type=Path, help="Root directory containing commit/vuln/<i> structure")
  generate_parser.add_argument("output_csv", type=Path, help="Output CSV file path")
  generate_parser.add_argument("--commit", dest="commit_id", type=str, help="Commit ID to process (process all commits if omitted)")

  report_parser = subparsers.add_parser("report", help="Generate Quarto HTML reports from CSV")
  report_parser.add_argument("output_csv", type=Path, help="CSV previously generated")
  report_parser.add_argument("--outdir", type=Path, default=Path("out"), help="Path to output quarto reports")

  args = parser.parse_args()

  if args.command == "generate":
    print(f"Génération du dataset depuis {args.root_dir}...")
    cache = DatasetCache(args.output_csv)
    generate(args.root_dir, cache, commit=args.commit_id)
    print(f"CSV généré : {args.output_csv}")

  elif args.command == "report":
    print(f"Génération des rapports HTML à partir de {args.output_csv}...")
    reports.render_reports(outdir=args.outdir, cache_csv=args.output_csv)
    print("Rapports HTML générés avec succès.")

if __name__ == "__main__":
    main()
