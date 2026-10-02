# frozen_string_literal: true

require_relative "production"

Rails.application.configure do
  config.enable_reloading = false

  config.assume_ssl = false
  config.force_ssl  = false

  # FIXME: Tags are not being reset right now
  config.log_tags = []

  if ENV["DEBUG"] == "1"
    config.consider_all_requests_local = true
    config.action_dispatch.show_exceptions = :none
    config.log_level = :debug
    config.logger = Logger.new($stdout)
  end

  config.cache_store = :memory_store

  if config.respond_to?(:active_job)
    config.active_job.queue_adapter = :inline
  end

  if config.respond_to?(:action_mailer)
    config.action_mailer.delivery_method = :null
  end

  if config.respond_to?(:active_storage)
    config.active_storage.variant_processor = :null
  end

  # The demo service worker passes a random key, generated once per worker.
  # It stays the same across the Rails restarts around a restore, as a
  # production key does (the key is not stored in the database).
  config.secret_key_base = ENV.fetch("SECRET_KEY_BASE")
  # Use a different session cookie name to avoid conflicts
  config.session_store :cookie_store, key: "_local_session"
end
