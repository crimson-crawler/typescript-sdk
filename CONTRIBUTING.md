# Contributing

Thank you for helping improve Crimson Crawler. Use the repository issue tracker for reproducible defects, documentation gaps, and focused feature proposals. Discuss substantial API or behavior changes before opening a pull request so work does not conflict with the published compatibility contract.

## Security reports

Do not open a public issue for a suspected vulnerability or exposed credential. Follow [SECURITY.md](SECURITY.md) and use GitHub's private vulnerability reporting channel.

## Pull requests

1. Branch from `main` and keep the change focused.
2. Add or update tests for observable behavior.
3. Run the repository's documented lint, test, build, and package checks.
4. Update public documentation when behavior, configuration, or compatibility changes.
5. Explain the user-visible change, security impact, and verification in the pull request.

Generated SDK files come from `openapi.snapshot.json`. Do not hand-edit generated output; update the API source and regenerate through the documented workflow. Release workflows, package versions, and generated artifacts are maintained by the Crimson Crawler release process.

By contributing, you confirm that you have the right to submit the work under this repository's Apache License 2.0 and that no employer, customer, partner, or other agreement prevents its publication.

Keep discussion technical and respectful. Harassment, personal attacks, disclosure of private information, and unauthorized security testing are not acceptable.

## Support

Use the repository issue tracker for defects and the [Crimson Crawler documentation](https://crimsoncrawler.com/docs/introduction/) for setup and usage. Security reports must use the private process above.
