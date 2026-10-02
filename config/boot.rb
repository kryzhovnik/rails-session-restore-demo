ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

require "bundler/setup" unless RUBY_PLATFORM =~ /wasm/ # Set up gems listed in the Gemfile.
