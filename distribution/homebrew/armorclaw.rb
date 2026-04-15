# Homebrew formula for ArmorClaw
#
# Install:
#   brew install armorclaw
#
# This formula installs ArmorClaw via npm. It requires Node.js 22+,
# which Homebrew will install as a dependency if not already present.
#
# After installation, run:
#   armorclaw install
# to launch the setup wizard.

class Armorclaw < Formula
  desc "OpenClaw, hardened for small business — AI agent with built-in security"
  homepage "https://armorclaw.ai"
  url "https://registry.npmjs.org/armorclaw/-/armorclaw-0.1.0.tgz"
  sha256 "PLACEHOLDER_SHA256"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", "--prefix", libexec, "-g", "armorclaw@#{version}"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def post_install
    ohai "ArmorClaw installed. Run 'armorclaw install' to launch the setup wizard."
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/armorclaw --version")
  end
end
