class WhoamiController < ApplicationController
  def show
    @whoami = {
      host:         request.host,
      session_id:   Current.session.id,
      user_id:      Current.user.id,
      email:        Current.user.email_address,
      private_note: Current.user.notes.pick(:body)
    }

    respond_to do |format|
      format.html
      format.json { render json: @whoami }
    end
  end
end
